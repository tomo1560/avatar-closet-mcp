/**
 * Library download-file snapshot for `booth_check_updates` (PLAN §3 / Phase 5, omnooth `outdated`
 * equivalent). The snapshot records which downloadables each purchased item had the last time the
 * library was listed; diffing it against the current listing reveals updated items (a version bump
 * usually uploads a new downloadable).
 *
 * Everything except {@link loadSnapshot} / {@link saveSnapshot} is pure.
 */
import { join } from "node:path";
import { z } from "zod";
import { toItemId } from "../booth/item-id.js";
import type { LibraryItem } from "../parsers/library.js";
import { getCacheDir } from "../profile.js";
import { readSnapshotText, writeFileAtomic } from "./snapshot-file.js";

/** Baseline of `booth_check_updates`: advanced only by that check ("compared with the last check"). */
export const SNAPSHOT_FILE_NAME = "library-snapshot.json";
/**
 * File composition at the last complete library + gifts walk, used only to re-fetch the item metadata
 * of changed items (PLAN §3.5.7). Separate from the update-check baseline so that `sync` or avatar
 * listings never hide updates from `booth_check_updates`.
 */
export const CACHE_SNAPSHOT_FILE_NAME = "item-cache-snapshot.json";
export const SNAPSHOT_VERSION = 1;

export interface SnapshotFile {
  readonly downloadable_id: string;
  readonly file_name: string | null;
}

export interface SnapshotItem {
  readonly name: string;
  /** Unique by `downloadable_id`, sorted numerically by it. */
  readonly files: readonly SnapshotFile[];
}

/**
 * On-disk format of `{cacheDir}/library-snapshot.json`.
 * `taken_at` is ISO 8601 UTC without milliseconds (`2026-10-12T03:00:00Z`).
 */
export interface LibrarySnapshot {
  readonly version: typeof SNAPSHOT_VERSION;
  readonly taken_at: string;
  readonly items: Readonly<Record<string, SnapshotItem>>;
}

export interface RenamedFile {
  readonly downloadable_id: string;
  readonly from: string | null;
  readonly to: string | null;
}

export interface ChangedItem {
  readonly item_id: string;
  /** Current name. */
  readonly name: string;
  /** New downloadable ids: the typical "the item was updated" signal. */
  readonly added_files: readonly SnapshotFile[];
  readonly removed_files: readonly SnapshotFile[];
  /** Same downloadable id, different file name. */
  readonly renamed_files: readonly RenamedFile[];
}

export interface ItemRef {
  readonly item_id: string;
  readonly name: string;
}

export interface SnapshotDiff {
  /** No previous snapshot: nothing was compared, every list is empty and `unchanged_count` is 0. */
  readonly first_run: boolean;
  /** Items present in both snapshots whose file composition differs. Sorted by item id. */
  readonly changed: readonly ChangedItem[];
  readonly new_items: readonly ItemRef[];
  readonly removed_items: readonly ItemRef[];
  /** Items present in both snapshots with identical files (a name-only change counts as unchanged). */
  readonly unchanged_count: number;
}

export interface SnapshotScopeOptions {
  /** Restrict to these items. Invalid ids throw INVALID_INPUT; ids in neither snapshot are ignored. */
  readonly itemIds?: readonly (string | number)[] | undefined;
}

export interface LoadSnapshotResult {
  readonly snapshot: LibrarySnapshot | null;
  /** The file exists but could not be read or validated; it is treated as missing (a new baseline). */
  readonly corrupt: boolean;
}

const snapshotSchema = z.object({
  version: z.literal(SNAPSHOT_VERSION),
  taken_at: z.iso.datetime({ offset: true }),
  items: z.record(
    z.string().regex(/^[1-9]\d{0,11}$/),
    z.object({
      name: z.string(),
      files: z.array(z.object({ downloadable_id: z.string().min(1), file_name: z.string().nullable() })),
    }),
  ),
});

export function getSnapshotFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(getCacheDir(env), SNAPSHOT_FILE_NAME);
}

export function getCacheSnapshotFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(getCacheDir(env), CACHE_SNAPSHOT_FILE_NAME);
}

/**
 * Snapshot of a library listing. Duplicate item ids (library + gifts) are merged: first name wins,
 * files are the union by `downloadable_id` (first file name wins). Throws INVALID_INPUT for an
 * item id that is not a canonical BOOTH item id.
 */
export function buildSnapshot(items: readonly LibraryItem[], now: Date): LibrarySnapshot {
  const merged = new Map<string, { name: string; files: Map<string, SnapshotFile> }>();
  for (const item of items) {
    const id = toItemId(item.item_id);
    const entry = merged.get(id) ?? { name: item.name, files: new Map<string, SnapshotFile>() };
    for (const { downloadable_id, file_name } of item.downloadables) {
      if (!entry.files.has(downloadable_id)) entry.files.set(downloadable_id, { downloadable_id, file_name });
    }
    merged.set(id, entry);
  }
  const entries = [...merged.entries()]
    .sort(([a], [b]) => compareNumericIds(a, b))
    .map(([id, entry]): [string, SnapshotItem] => [id, { name: entry.name, files: sortFiles([...entry.files.values()]) }]);
  return { version: SNAPSHOT_VERSION, taken_at: formatTimestamp(now), items: Object.fromEntries(entries) };
}

/** Compares two snapshots; file identity is the `downloadable_id`. */
export function diffSnapshots(
  previous: LibrarySnapshot | null,
  current: LibrarySnapshot,
  options: SnapshotScopeOptions = {},
): SnapshotDiff {
  const scope = toScope(options.itemIds);
  if (previous === null) return { first_run: true, changed: [], new_items: [], removed_items: [], unchanged_count: 0 };

  const inScope = (id: string): boolean => scope === null || scope.has(id);
  const ids = [...new Set([...Object.keys(previous.items), ...Object.keys(current.items)])]
    .filter(inScope)
    .sort(compareNumericIds);

  const changed: ChangedItem[] = [];
  const newItems: ItemRef[] = [];
  const removedItems: ItemRef[] = [];
  let unchanged = 0;
  for (const id of ids) {
    const before = previous.items[id];
    const after = current.items[id];
    if (!before && after) newItems.push({ item_id: id, name: after.name });
    else if (before && !after) removedItems.push({ item_id: id, name: before.name });
    else if (before && after) {
      const change = diffFiles(id, before, after);
      if (change) changed.push(change);
      else unchanged += 1;
    }
  }
  return { first_run: false, changed, new_items: newItems, removed_items: removedItems, unchanged_count: unchanged };
}

/**
 * Ids whose download file composition changed: pass as `forceIds` to `ItemCache.fetchMany` so their
 * item JSON is re-fetched even when the cache is fresh (PLAN §3.5.7). New items are not included.
 */
export function changedItemIdsForCache(diff: SnapshotDiff): string[] {
  return diff.changed.map((entry) => entry.item_id);
}

/**
 * The snapshot to save after a check. Without `itemIds` (or without a previous snapshot) this is
 * `current`. With `itemIds`, only those items are updated from `current` (removed when absent) and
 * every other item keeps its previous entry, so changes that were not reported stay detectable.
 */
export function mergeSnapshot(
  previous: LibrarySnapshot | null,
  current: LibrarySnapshot,
  options: SnapshotScopeOptions = {},
): LibrarySnapshot {
  const scope = toScope(options.itemIds);
  if (previous === null || scope === null) return current;
  const kept = Object.entries(previous.items).filter(([id]) => !scope.has(id));
  const updated = Object.entries(current.items).filter(([id]) => scope.has(id));
  const items = Object.fromEntries([...kept, ...updated].sort(([a], [b]) => compareNumericIds(a, b)));
  return { version: SNAPSHOT_VERSION, taken_at: current.taken_at, items };
}

/** Reads the snapshot. Never throws: missing → `{ snapshot: null, corrupt: false }`, unusable → `corrupt: true`. */
export async function loadSnapshot(file: string = getSnapshotFile()): Promise<LoadSnapshotResult> {
  const read = await readSnapshotText(file);
  if (read.status === "missing") return { snapshot: null, corrupt: false };
  if (read.status === "unreadable") return { snapshot: null, corrupt: true };
  let json: unknown;
  try {
    json = JSON.parse(read.text);
  } catch {
    return { snapshot: null, corrupt: true };
  }
  const parsed = snapshotSchema.safeParse(json);
  return parsed.success ? { snapshot: parsed.data, corrupt: false } : { snapshot: null, corrupt: true };
}

/**
 * Atomically writes the snapshot (tmp file + rename, file 0o600, directories 0o700, created
 * recursively). Throws an Error whose message carries only the file system error code (no path).
 */
export async function saveSnapshot(snapshot: LibrarySnapshot, file: string = getSnapshotFile()): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(snapshot)}\n`, "ライブラリのスナップショット");
}

function diffFiles(itemId: string, before: SnapshotItem, after: SnapshotItem): ChangedItem | null {
  const beforeById = new Map(before.files.map((file) => [file.downloadable_id, file]));
  const afterById = new Map(after.files.map((file) => [file.downloadable_id, file]));
  const added = sortFiles([...afterById.values()].filter((file) => !beforeById.has(file.downloadable_id)));
  const removed = sortFiles([...beforeById.values()].filter((file) => !afterById.has(file.downloadable_id)));
  const renamed = sortFiles([...afterById.values()])
    .map((file): RenamedFile | null => {
      const old = beforeById.get(file.downloadable_id);
      return old && old.file_name !== file.file_name
        ? { downloadable_id: file.downloadable_id, from: old.file_name, to: file.file_name }
        : null;
    })
    .filter((entry): entry is RenamedFile => entry !== null);
  if (added.length === 0 && removed.length === 0 && renamed.length === 0) return null;
  return { item_id: itemId, name: after.name, added_files: added, removed_files: removed, renamed_files: renamed };
}

function toScope(itemIds: readonly (string | number)[] | undefined): ReadonlySet<string> | null {
  return itemIds === undefined ? null : new Set(itemIds.map(toItemId));
}

function sortFiles(files: readonly SnapshotFile[]): SnapshotFile[] {
  return [...files].sort((a, b) => compareNumericIds(a.downloadable_id, b.downloadable_id));
}

/** Numeric order for digit strings (shorter first), plain string order otherwise. */
function compareNumericIds(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** ISO 8601 UTC without milliseconds, e.g. `2026-10-12T03:00:00Z` (same format as the item cache). */
function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
