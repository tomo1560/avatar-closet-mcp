import { ACCOUNTS_ORIGIN } from "../browser/url-policy.js";
import type { FetchManyError } from "../cache/item-cache.js";
import type { BoothErrorCode } from "../errors.js";
import type { BoothResult, SyncResult } from "../types.js";
import type { MetadataBatch, ServiceContext } from "./context.js";
import { collectOwnedItems } from "./library.js";
import { fetchOwnedMetadata } from "./owned-snapshot.js";
import { invalidInput, wrap } from "./result.js";

export const DEFAULT_SYNC_ITEMS = 20;
/** Upper bound for one MCP call (about 100 s at 1 request/second). */
export const MAX_SYNC_ITEMS = 100;
/** Upper bound for one CLI `sync` run (PLAN §3.5.7: pre-sync everything, but never unbounded). */
export const MAX_SYNC_ALL_ITEMS = 2_000;
const SYNC_BATCH_SIZE = 20;
const LIBRARY_URL = `${ACCOUNTS_ORIGIN}/library`;
/** Errors after which further requests in this run are pointless (mirrors ItemCache.fetchMany). */
const STOP_CODES: ReadonlySet<BoothErrorCode | "CACHE_WRITE_FAILED"> = new Set(["RATE_LIMITED", "AUTH_REQUIRED"]);

export interface SyncProgress {
  readonly total_items: number;
  readonly fetched: number;
  readonly remaining: number;
}

export interface SyncAllOptions {
  /** Maximum number of item requests (successes and failures) in this run. Default and upper bound: MAX_SYNC_ALL_ITEMS. */
  maxItems?: number | undefined;
  onProgress?: ((progress: SyncProgress) => void) | undefined;
}

/** One cache-first pass over the owned items (library + gifts), fetching at most `maxItems` uncached ones. */
export async function syncLibraryMetadata(ctx: ServiceContext, maxItems = DEFAULT_SYNC_ITEMS): Promise<BoothResult<SyncResult>> {
  assertRange(maxItems, MAX_SYNC_ITEMS, "max_items");
  const owned = await collectOwnedItems(ctx);
  const ids = owned.items.map((item) => item.item_id);
  const batch = await fetchOwnedMetadata(ctx, owned, ids, maxItems);
  return wrap(toSyncResult(ids.length, [batch], owned.truncated), LIBRARY_URL);
}

/**
 * Walks the library once, then fetches in batches until nothing remains, the item budget is used, a batch
 * makes no progress, or BOOTH rate-limits / signs out. Used by the CLI `sync` command.
 */
export async function syncAllMetadata(ctx: ServiceContext, options: SyncAllOptions = {}): Promise<BoothResult<SyncResult>> {
  const maxItems = options.maxItems ?? MAX_SYNC_ALL_ITEMS;
  assertRange(maxItems, MAX_SYNC_ALL_ITEMS, "max");
  const owned = await collectOwnedItems(ctx);
  const ids = owned.items.map((item) => item.item_id);
  const batches: MetadataBatch[] = [];
  let pending: readonly string[] = ids;
  let attempts = 0;
  while (attempts < maxItems) {
    const batch = await fetchOwnedMetadata(ctx, owned, pending, Math.min(SYNC_BATCH_SIZE, maxItems - attempts));
    batches.push(batch);
    attempts += batch.attempts;
    const madeProgress = batch.remaining.length < pending.length;
    pending = batch.remaining;
    options.onProgress?.({ total_items: ids.length, fetched: sumFetched(batches), remaining: pending.length });
    if (pending.length === 0 || !madeProgress || batch.errors.some((error) => STOP_CODES.has(error.code))) break;
  }
  return wrap(toSyncResult(ids.length, batches, owned.truncated), LIBRARY_URL);
}

function toSyncResult(totalItems: number, batches: readonly MetadataBatch[], truncated: boolean): SyncResult {
  const last = batches[batches.length - 1];
  const errors: FetchManyError[] = batches.flatMap((batch) => [...batch.errors]);
  return {
    total_items: totalItems,
    cached: batches[0]?.cached ?? 0,
    fetched: sumFetched(batches),
    remaining: last?.remaining.length ?? 0,
    unavailable: new Set(batches.flatMap((batch) => [...batch.unavailable])).size,
    errors: errors.map((error) => ({ item_id: error.item_id, code: error.code, message: error.message })),
    truncated,
  };
}

function sumFetched(batches: readonly MetadataBatch[]): number {
  return batches.reduce((sum, batch) => sum + batch.fetched, 0);
}

function assertRange(value: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw invalidInput(`${label} は 1〜${max} の整数で指定してください。`);
  }
}
