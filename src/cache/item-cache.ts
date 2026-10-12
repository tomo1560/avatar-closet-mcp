import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { toItemId } from "../booth/item-id.js";
import { describeIssues, rawBoothItemSchema, type RawBoothItem } from "../booth/item-json.js";
import { BoothError, asBoothError, type BoothErrorCode } from "../errors.js";
import { getCacheDir } from "../profile.js";
import { toCacheableItem } from "./cacheable-item.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
/** PLAN §3.5.7: items are re-fetched after 7 days (configurable with BOOTH_MCP_CACHE_TTL_DAYS). */
export const DEFAULT_CACHE_TTL_DAYS = 7;
export const DEFAULT_ITEM_CACHE_TTL_MS = DEFAULT_CACHE_TTL_DAYS * DAY_MS;
export const CACHE_TTL_ENV = "BOOTH_MCP_CACHE_TTL_DAYS";
/** About one hour to one year. */
export const MIN_CACHE_TTL_DAYS = 0.04;
export const MAX_CACHE_TTL_DAYS = 365;
/** PLAN §3.5.7: one MCP call fetches at most ~20 uncached items. */
export const DEFAULT_MAX_FETCH = 20;
/** Real records are a few KiB to a few hundred KiB; anything larger is not read into memory. */
export const MAX_CACHE_RECORD_BYTES = 2 * 1_024 * 1_024;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const RECORD_FILE_PATTERN = /^([1-9]\d{0,11})\.json$/;
/** Errors that make further requests pointless (or harmful) in this run. */
const STOP_CODES: ReadonlySet<BoothErrorCode> = new Set<BoothErrorCode>(["RATE_LIMITED", "AUTH_REQUIRED"]);

const ttlDaysSchema = z.coerce.number().min(MIN_CACHE_TTL_DAYS).max(MAX_CACHE_TTL_DAYS);

export interface CacheTtlSetting {
  readonly ttlMs: number;
  readonly days: number;
  /** Set when the environment value was invalid and the default is used instead. */
  readonly warning?: string;
}

/**
 * Cache TTL from `BOOTH_MCP_CACHE_TTL_DAYS` (PLAN §3.5.7 "TTL 7日（設定可）"). Unset or empty means
 * 7 days. An invalid value does not stop the server: the default is used and a warning is returned.
 */
export function resolveCacheTtl(env: NodeJS.ProcessEnv = process.env): CacheTtlSetting {
  const raw = env[CACHE_TTL_ENV]?.trim();
  const fallback = { ttlMs: DEFAULT_ITEM_CACHE_TTL_MS, days: DEFAULT_CACHE_TTL_DAYS };
  if (raw === undefined || raw === "") return fallback;
  const parsed = ttlDaysSchema.safeParse(raw);
  if (parsed.success) return { ttlMs: Math.round(parsed.data * DAY_MS), days: parsed.data };
  return {
    ...fallback,
    warning:
      `${CACHE_TTL_ENV} は ${MIN_CACHE_TTL_DAYS}〜${MAX_CACHE_TTL_DAYS} の日数で指定してください。` +
      `値が不正なため既定の ${DEFAULT_CACHE_TTL_DAYS} 日を使います。`,
  };
}

const recordSchema = z.object({
  item_id: z.number().int().positive(),
  fetched_at: z.iso.datetime({ offset: true }),
  etag: z.string().nullable(),
  item: rawBoothItemSchema,
});

/** On-disk format of `{dir}/{item_id}.json`. `fetched_at` is ISO 8601 UTC (`2026-10-12T03:00:00Z`). */
export interface ItemCacheRecord {
  item_id: number;
  fetched_at: string;
  etag: string | null;
  item: RawBoothItem;
}

export interface CorruptCacheEntry {
  item_id: string;
  reason: string;
}

export interface ItemCacheOptions {
  dir?: string | undefined;
  ttlMs?: number | undefined;
  now?: (() => Date) | undefined;
  /** Called when a cache file exists but cannot be used. Such files are treated as missing. */
  onCorrupt?: ((entry: CorruptCacheEntry) => void) | undefined;
}

/** Fetches one item; expected to be the rate-limited reader (`getItem(...).raw`). */
export type ItemFetcher = (itemId: string) => Promise<RawBoothItem>;

export interface FetchManyOptions {
  /** Maximum number of fetch attempts in this call (default 20). `0` = cache only. */
  maxFetch?: number | undefined;
  /** Items whose download file composition changed: re-fetched even when the cache is fresh. */
  forceIds?: readonly (string | number)[] | undefined;
}

export interface CachedItemEntry {
  item_id: string;
  item: RawBoothItem;
  fetched_at: string;
  /** `false` only when the item was fetched during this call. */
  from_cache: boolean;
  /** `true` when an expired / forced cache record is served because it could not be refreshed. */
  stale: boolean;
}

export type FetchManyErrorCode = BoothErrorCode | "CACHE_WRITE_FAILED";

export interface FetchManyError {
  item_id: string;
  code: FetchManyErrorCode;
  message: string;
}

export interface FetchManyResult {
  /** In input order. Includes stale records for items that could not be refreshed. */
  items: CachedItemEntry[];
  /** Number of items successfully fetched in this call. */
  fetched: number;
  /** Items still needing a fetch (budget exhausted or stopped early), in input order. */
  remaining: string[];
  errors: FetchManyError[];
}

type Lookup = { status: "missing" } | { status: "corrupt" } | { status: "ok"; record: ItemCacheRecord };

interface FetchLoopResult {
  fetchedEntries: Map<string, CachedItemEntry>;
  fetched: number;
  remaining: string[];
  errors: FetchManyError[];
}

export class ItemCache {
  readonly dir: string;
  readonly ttlMs: number;
  private readonly now: () => Date;
  private readonly onCorrupt: (entry: CorruptCacheEntry) => void;

  constructor(options: ItemCacheOptions = {}) {
    this.dir = options.dir ?? join(getCacheDir(), "items");
    this.ttlMs = options.ttlMs ?? DEFAULT_ITEM_CACHE_TTL_MS;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 0) throw invalidInput("キャッシュの TTL は 0 以上の数値で指定してください。");
    this.now = options.now ?? (() => new Date());
    this.onCorrupt = options.onCorrupt ?? (() => undefined);
  }

  /** Fresh record or `null` (missing, expired or corrupt). */
  async get(id: string | number): Promise<ItemCacheRecord | null> {
    const record = await this.getStale(id);
    return record && this.isFresh(record) ? record : null;
  }

  /** Record regardless of TTL, or `null` when missing / corrupt. */
  async getStale(id: string | number): Promise<ItemCacheRecord | null> {
    const lookup = await this.lookup(toItemId(id));
    return lookup.status === "ok" ? lookup.record : null;
  }

  isFresh(record: ItemCacheRecord): boolean {
    const age = this.now().getTime() - Date.parse(record.fetched_at);
    // A timestamp in the future (clock skew, hand-edited file) is not trusted.
    return age >= 0 && age < this.ttlMs;
  }

  /** Atomically writes `{dir}/{id}.json` (tmp file + rename). Viewer-specific (logged-in) state is never stored. */
  async set(id: string | number, item: RawBoothItem, options: { etag?: string | null | undefined } = {}): Promise<ItemCacheRecord> {
    const itemId = toItemId(id);
    if (String(item.id) !== itemId) {
      throw invalidInput(`商品 ${String(item.id)} を ID ${itemId} としてキャッシュすることはできません。`);
    }
    const record: ItemCacheRecord = {
      item_id: Number(itemId),
      fetched_at: formatTimestamp(this.now()),
      etag: options.etag ?? null,
      item: toCacheableItem(item),
    };
    await this.writeAtomic(itemId, `${JSON.stringify(record)}\n`);
    return record;
  }

  /** Removes the record. Returns `false` when there was nothing to remove. */
  async invalidate(id: string | number): Promise<boolean> {
    try {
      await unlink(this.recordPath(toItemId(id)));
      return true;
    } catch (error) {
      if (isMissingFileError(error)) return false;
      throw error;
    }
  }

  /** Ids of all records on disk (valid file names only; contents are not checked), ascending. */
  async listIds(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
    return names
      .map((name) => RECORD_FILE_PATTERN.exec(name)?.[1])
      .filter((id): id is string => id !== undefined)
      .sort(compareItemIds);
  }

  /**
   * Cache-first bulk lookup (PLAN §3.5.7). Fresh records are served without requests; misses are
   * fetched sequentially, at most `maxFetch` attempts. Per-item failures (NOT_FOUND, BOOTH_CHANGED,
   * NETWORK_ERROR) are collected and skipped; RATE_LIMITED / AUTH_REQUIRED stop the run and the
   * unprocessed ids are returned in `remaining`.
   */
  async fetchMany(
    ids: readonly (string | number)[],
    fetcher: ItemFetcher,
    options: FetchManyOptions = {},
  ): Promise<FetchManyResult> {
    const maxFetch = options.maxFetch ?? DEFAULT_MAX_FETCH;
    if (!Number.isInteger(maxFetch) || maxFetch < 0) throw invalidInput("maxFetch は 0 以上の整数で指定してください。");
    const orderedIds = [...new Set(ids.map(toItemId))];
    const forced = new Set((options.forceIds ?? []).map(toItemId));

    const fresh = new Map<string, CachedItemEntry>();
    const stale = new Map<string, ItemCacheRecord>();
    const misses: string[] = [];
    for (const id of orderedIds) {
      const record = await this.getStale(id);
      if (record && !forced.has(id) && this.isFresh(record)) {
        fresh.set(id, toEntry(record, false));
        continue;
      }
      if (record) stale.set(id, record);
      misses.push(id);
    }

    const loop = await this.fetchMisses(misses, fetcher, maxFetch);
    const items = orderedIds.flatMap((id) => {
      const entry = fresh.get(id) ?? loop.fetchedEntries.get(id);
      if (entry) return [entry];
      const staleRecord = stale.get(id);
      return staleRecord ? [toEntry(staleRecord, true)] : [];
    });
    return { items, fetched: loop.fetched, remaining: loop.remaining, errors: loop.errors };
  }

  private async fetchMisses(misses: readonly string[], fetcher: ItemFetcher, maxFetch: number): Promise<FetchLoopResult> {
    const fetchedEntries = new Map<string, CachedItemEntry>();
    const errors: FetchManyError[] = [];
    let fetched = 0;
    for (const [index, id] of misses.entries()) {
      if (index >= maxFetch) return { fetchedEntries, fetched, remaining: misses.slice(index), errors };
      let item: RawBoothItem;
      try {
        item = await fetcher(id);
      } catch (error) {
        const boothError = asBoothError(error);
        errors.push({ item_id: id, code: boothError.code, message: boothError.message });
        if (STOP_CODES.has(boothError.code)) return { fetchedEntries, fetched, remaining: misses.slice(index), errors };
        continue;
      }
      if (String(item.id) !== id) {
        errors.push({ item_id: id, code: "BOOTH_CHANGED", message: `商品 ${id} を要求しましたが商品 ${item.id} が返されました。` });
        continue;
      }
      fetched += 1;
      fetchedEntries.set(id, await this.store(id, item, errors));
    }
    return { fetchedEntries, fetched, remaining: [], errors };
  }

  /** Writes a freshly fetched item; a write failure is reported but the item is still returned. */
  private async store(id: string, item: RawBoothItem, errors: FetchManyError[]): Promise<CachedItemEntry> {
    try {
      const record = await this.set(id, item);
      return { item_id: id, item: record.item, fetched_at: record.fetched_at, from_cache: false, stale: false };
    } catch (error) {
      // Only the error code: file system messages contain local paths (and thus the user name).
      errors.push({ item_id: id, code: "CACHE_WRITE_FAILED", message: `キャッシュファイルを書き込めませんでした（${errorCode(error)}）。` });
      return { item_id: id, item: toCacheableItem(item), fetched_at: formatTimestamp(this.now()), from_cache: false, stale: false };
    }
  }

  private async lookup(itemId: string): Promise<Lookup> {
    const read = await readCappedText(this.recordPath(itemId), MAX_CACHE_RECORD_BYTES);
    if (read.status === "missing") return { status: "missing" };
    if (read.status === "unusable") return this.reportCorrupt(itemId, read.reason);
    const { text } = read;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return this.reportCorrupt(itemId, "invalid JSON");
    }
    const parsed = recordSchema.safeParse(json);
    if (!parsed.success) return this.reportCorrupt(itemId, `unexpected format (${describeIssues(parsed.error)})`);
    if (String(parsed.data.item_id) !== itemId || String(parsed.data.item.id) !== itemId) {
      return this.reportCorrupt(itemId, "item id does not match the file name");
    }
    // Files written before viewer state was stripped on write may still hold it (e.g. already_bought_digital).
    return { status: "ok", record: { ...parsed.data, item: toCacheableItem(parsed.data.item) } };
  }

  private reportCorrupt(itemId: string, reason: string): Lookup {
    this.onCorrupt({ item_id: itemId, reason });
    return { status: "corrupt" };
  }

  private async writeAtomic(itemId: string, content: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: DIR_MODE });
    const tmpPath = join(this.dir, `${itemId}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(tmpPath, content, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
      await rename(tmpPath, this.recordPath(itemId));
    } catch (error) {
      // Best-effort cleanup; the original error is what matters to the caller.
      await unlink(tmpPath).catch(() => undefined);
      throw error;
    }
  }

  /** `itemId` must already be validated by `toItemId` (digits only), which rules out path traversal. */
  private recordPath(itemId: string): string {
    return join(this.dir, `${itemId}.json`);
  }
}

type CappedRead = { status: "missing" } | { status: "unusable"; reason: string } | { status: "ok"; text: string };

/** Reads a UTF-8 file of at most `maxBytes` (size checked on the open handle before reading). Never throws. */
async function readCappedText(path: string, maxBytes: number): Promise<CappedRead> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile()) return { status: "unusable", reason: "unreadable (not a file)" };
    if (info.size > maxBytes) return { status: "unusable", reason: "too large" };
    return { status: "ok", text: await handle.readFile("utf8") };
  } catch (error) {
    return isMissingFileError(error) ? { status: "missing" } : { status: "unusable", reason: `unreadable (${errorCode(error)})` };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function toEntry(record: ItemCacheRecord, stale: boolean): CachedItemEntry {
  return { item_id: String(record.item_id), item: record.item, fetched_at: record.fetched_at, from_cache: true, stale };
}

/** ISO 8601 UTC without milliseconds, e.g. `2026-10-12T03:00:00Z`. */
function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function compareItemIds(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return "unknown error";
}

function isMissingFileError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function invalidInput(message: string): BoothError {
  return new BoothError("INVALID_INPUT", message);
}
