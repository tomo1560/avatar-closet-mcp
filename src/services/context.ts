import { isItemId } from "../booth/item-id.js";
import type { RawBoothItem } from "../booth/item-json.js";
import { getItem } from "../booth/public.js";
import type { BoothReader } from "../browser/reader.js";
import type { FetchManyError, ItemCache, ItemFetcher } from "../cache/item-cache.js";
import type { UnavailableItems } from "../cache/unavailable-items.js";
import { BoothError } from "../errors.js";
import type { LibraryItem } from "../parsers/library.js";
import { loadAvatarDictionary, readUserAvatarEntries } from "../vrchat/avatars.js";
import type { AvatarDictionary, AvatarEntry } from "../vrchat/types.js";

/** Everything a use case needs. One instance per `BoothService`. */
export interface ServiceContext {
  readonly reader: BoothReader;
  readonly cache: ItemCache;
  readonly unavailable: UnavailableItems;
  /** avatars.json (user dictionary). */
  readonly avatarsFile: string;
  /** Recent library + gifts walk, reused by sync / avatar calls for a few minutes. */
  readonly ownedItems: Memo<OwnedItems>;
}

export interface OwnedItems {
  readonly items: readonly LibraryItem[];
  readonly truncated: boolean;
}

/** Owned items rarely change between consecutive calls; re-reading up to 40 pages each time is wasteful. */
export const OWNED_ITEMS_TTL_MS = 5 * 60 * 1_000;

/** Single-value, time-limited memo. Failed loads are not remembered. */
export class Memo<T> {
  private entry: { readonly value: T; readonly at: number } | undefined;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(load: () => Promise<T>): Promise<T> {
    if (this.entry && this.now() - this.entry.at < this.ttlMs) return this.entry.value;
    const value = await load();
    this.entry = { value, at: this.now() };
    return value;
  }

  clear(): void {
    this.entry = undefined;
  }
}

export interface CachedRawItem {
  readonly raw: RawBoothItem;
  readonly fetched_at: string;
  readonly from_cache: boolean;
}

export interface MetadataBatch {
  /** Metadata available for this call (fresh, just fetched, or stale when a refresh was not possible). */
  readonly items: ReadonlyMap<string, RawBoothItem>;
  /** Served from a fresh cache record. */
  readonly cached: number;
  readonly fetched: number;
  /** Requests made in this call (successes and failures). */
  readonly attempts: number;
  /** Ids that still need a fetch (budget exhausted or stopped early). */
  readonly remaining: readonly string[];
  /** Ids known to be deleted / private (404), skipped or found in this call. */
  readonly unavailable: readonly string[];
  /** Failures other than 404. */
  readonly errors: readonly FetchManyError[];
}

/** Viewer-specific (logged-in) fields are reset so the cache only holds public item data. */
export function toCacheableItem(raw: RawBoothItem): RawBoothItem {
  return {
    ...raw,
    wished: false,
    order: null,
    gift: null,
    ...("past_purchase_count" in raw ? { past_purchase_count: 0 } : {}),
    variations: raw.variations.map((variation) => ({
      ...variation,
      ...("order_url" in variation ? { order_url: null } : {}),
      ...("past_purchase_count" in variation ? { past_purchase_count: 0 } : {}),
    })),
  };
}

/** Fetches `items/{id}.json` through the rate-limited reader (used by `ItemCache.fetchMany`). */
export function createItemFetcher(reader: BoothReader): ItemFetcher {
  return async (itemId: string): Promise<RawBoothItem> => toCacheableItem((await getItem(reader, itemId)).raw);
}

/** Writes an item into the cache. A write failure is not fatal for the caller (the data was fetched). */
export async function storeItem(ctx: ServiceContext, itemId: string, raw: RawBoothItem): Promise<string> {
  try {
    return (await ctx.cache.set(itemId, toCacheableItem(raw))).fetched_at;
  } catch {
    return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
  }
}

/** Cache-first single item: a fresh record is served without a request, otherwise one GET (then cached). */
export async function getCachedItem(ctx: ServiceContext, itemId: string): Promise<CachedRawItem> {
  const record = await ctx.cache.get(itemId);
  if (record) return { raw: record.item, fetched_at: record.fetched_at, from_cache: true };
  const { raw } = await getItem(ctx.reader, itemId);
  return { raw, fetched_at: await storeItem(ctx, itemId, raw), from_cache: false };
}

/**
 * Cache-first bulk metadata (PLAN §3.5.7): at most `maxFetch` requests. Items known to be deleted are
 * skipped, and newly found 404s are remembered so they do not consume the budget of later calls.
 */
export async function fetchMetadata(ctx: ServiceContext, ids: readonly string[], maxFetch: number): Promise<MetadataBatch> {
  const skipped = await ctx.unavailable.freshIds();
  const unique = [...new Set(ids.filter(isItemId))];
  const wanted = unique.filter((id) => !skipped.has(id));
  const result = await ctx.cache.fetchMany(wanted, createItemFetcher(ctx.reader), { maxFetch });
  const notFound = result.errors.filter((error) => error.code === "NOT_FOUND").map((error) => error.item_id);
  await ctx.unavailable.mark(notFound);
  return {
    items: new Map(result.items.map((entry) => [entry.item_id, entry.item])),
    cached: result.items.filter((entry) => entry.from_cache && !entry.stale).length,
    fetched: result.fetched,
    attempts: result.fetched + result.errors.filter((error) => error.code !== "CACHE_WRITE_FAILED").length,
    remaining: result.remaining,
    unavailable: [...unique.filter((id) => skipped.has(id)), ...notFound],
    errors: result.errors.filter((error) => error.code !== "NOT_FOUND"),
  };
}

/** Seed dictionary merged with the user's avatars.json, read per call so edits apply immediately. */
export async function loadDictionary(ctx: ServiceContext): Promise<AvatarDictionary> {
  try {
    return await loadAvatarDictionary(ctx.avatarsFile);
  } catch (error) {
    throw dictionaryError(error);
  }
}

/** Only the user's own avatars.json entries (no seed entries). */
export async function loadUserEntries(ctx: ServiceContext): Promise<AvatarEntry[]> {
  try {
    return await readUserAvatarEntries(ctx.avatarsFile);
  } catch (error) {
    throw dictionaryError(error);
  }
}

const QUOTED_TEXT = /'[^']*'|"[^"]*[\\/][^"]*"/gu;
const BARE_PATH = /[A-Za-z]:\\\S+|\/(?:home|Users|root|tmp|var|private)\/\S+/gu;

/** avatars.json problems become INVALID_INPUT without local paths (they contain the OS user name). */
export function dictionaryError(error: unknown): BoothError {
  if (error instanceof BoothError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const detail = (message.split("\n", 1)[0] ?? "").replace(QUOTED_TEXT, "'…'").replace(BARE_PATH, "…");
  return new BoothError("INVALID_INPUT", `avatars.json を使用できません（${detail}）。ファイルの内容を確認してください。`);
}
