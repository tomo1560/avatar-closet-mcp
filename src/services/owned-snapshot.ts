import {
  buildSnapshot,
  changedItemIdsForCache,
  diffSnapshots,
  loadSnapshot,
  mergeSnapshot,
  saveSnapshot,
  type LibrarySnapshot,
  type SnapshotDiff,
} from "../library/update-snapshot.js";
import { fetchMetadata, type MetadataBatch, type OwnedItems, type ServiceContext } from "./context.js";

/**
 * Cache-first metadata for owned items (PLAN §3.5.7 "ライブラリ一覧でファイル構成が変わった商品は即時再取得").
 *
 * After a complete library + gifts walk, items whose download files changed since the previous complete
 * walk are fetched first, even when their cache record is fresh. The file-composition snapshot
 * (`ctx.cacheSnapshotFile`) is then advanced, except for changed items that were not refreshed in this
 * call, which stay "changed" for the next call. A page-capped walk is never recorded: the missing pages
 * would look like removed items. A snapshot that cannot be written only produces a warning.
 * `extraForceIds` are re-fetched as well (e.g. items `booth_check_updates` found updated).
 */
export async function fetchOwnedMetadata(
  ctx: ServiceContext,
  owned: OwnedItems,
  ids: readonly string[],
  maxFetch: number,
  extraForceIds: readonly string[] = [],
): Promise<MetadataBatch> {
  if (owned.truncated) return fetchMetadata(ctx, ids, maxFetch, extraForceIds);
  const current = buildSnapshot(owned.items, new Date());
  const { snapshot: previous } = await loadSnapshot(ctx.cacheSnapshotFile);
  const diff = diffSnapshots(previous, current);
  const changed = changedItemIdsForCache(diff);
  const wanted = new Set(ids);
  const forced = new Set([...changed, ...extraForceIds].filter((id) => wanted.has(id)));
  const forceIds = [...forced];
  const batch = await fetchMetadata(ctx, [...forceIds, ...ids.filter((id) => !forced.has(id))], maxFetch, forceIds);
  await recordFileComposition(ctx, previous, current, diff, notRefreshed(changed, wanted, batch));
  return batch;
}

/** Changed items outside this call's ids, still pending, or failed (a 404 counts as done). */
function notRefreshed(changed: readonly string[], wanted: ReadonlySet<string>, batch: MetadataBatch): ReadonlySet<string> {
  const failed = new Set([...batch.remaining, ...batch.errors.map((error) => error.item_id)]);
  return new Set(changed.filter((id) => !wanted.has(id) || failed.has(id)));
}

async function recordFileComposition(
  ctx: ServiceContext,
  previous: LibrarySnapshot | null,
  current: LibrarySnapshot,
  diff: SnapshotDiff,
  pending: ReadonlySet<string>,
): Promise<void> {
  if (previous !== null && diff.changed.length === 0 && diff.new_items.length === 0 && diff.removed_items.length === 0) return;
  const scope =
    previous === null
      ? undefined
      : [...new Set([...Object.keys(previous.items), ...Object.keys(current.items)])].filter((id) => !pending.has(id));
  try {
    await saveSnapshot(mergeSnapshot(previous, current, { itemIds: scope }), ctx.cacheSnapshotFile);
  } catch (error) {
    // saveSnapshot messages name only the errno code, never the path.
    ctx.warn(error instanceof Error ? error.message : "ライブラリのスナップショットを書き込めませんでした。");
  }
}
