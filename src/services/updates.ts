import { toItemId } from "../booth/item-id.js";
import { ACCOUNTS_ORIGIN } from "../browser/url-policy.js";
import {
  buildSnapshot,
  diffSnapshots,
  loadSnapshot,
  mergeSnapshot,
  saveSnapshot,
  type ChangedItem,
  type ItemRef,
  type LibrarySnapshot,
  type SnapshotDiff,
} from "../library/update-snapshot.js";
import type { BoothResult, MetadataStatus } from "../types.js";
import { checkCompatibility } from "../vrchat/compatibility.js";
import type { AvatarDictionary, CompatibilityCheck } from "../vrchat/types.js";
import { loadDictionary, type OwnedItems, type ServiceContext } from "./context.js";
import { normalizeAvatarQuery } from "./items.js";
import { collectOwnedItems, LIST_MAX_FETCH, MAX_LIBRARY_PAGES, metadataStatus } from "./library.js";
import { fetchOwnedMetadata } from "./owned-snapshot.js";
import { invalidInput, wrap } from "./result.js";
import { HEURISTIC_NOTE, ownedFileNames } from "./vrchat-info.js";

export const MAX_UPDATE_ITEM_IDS = 100;
const LIBRARY_URL = `${ACCOUNTS_ORIGIN}/library`;
const INCOMPLETE_WARNING =
  `ライブラリまたはギフトが ${MAX_LIBRARY_PAGES} ページを超えるため全件を読めませんでした。` +
  "更新の確認には全件の一覧が必要なので、今回は比較も基準の記録もしていません。";
const CORRUPT_WARNING = "前回のスナップショットを読めなかったため、今回を初回として扱い、新しい基準を記録しました。";

export interface UpdateCheckInput {
  /** Restrict the check to these items; other items keep their previous baseline. */
  itemIds?: readonly (string | number)[] | undefined;
  /** Keep only changed / new items that support this avatar (evidence-based, cache-first metadata). */
  avatar?: string | undefined;
}

export interface UpdatedItem extends ChangedItem {
  /** Present with the `avatar` filter. */
  readonly compatibility?: CompatibilityCheck;
}

export interface NewOwnedItem extends ItemRef {
  readonly compatibility?: CompatibilityCheck;
}

/** `booth_check_updates` output: download-file changes since the previous check. */
export interface UpdateCheckResult extends Partial<MetadataStatus> {
  /** No previous check: a baseline was recorded and nothing was compared. */
  first_run: boolean;
  /** `false` when the library listing hit the page cap; nothing was compared or recorded then. */
  complete: boolean;
  changed: UpdatedItem[];
  new_items: NewOwnedItem[];
  removed_items: ItemRef[];
  unchanged_count: number;
  /** When the compared baseline was recorded (the previous check), `null` on a first run. */
  previous_snapshot_taken_at: string | null;
  /** When the current listing was recorded as the next baseline. */
  snapshot_taken_at: string | null;
  snapshot_saved: boolean;
  /** Library + gift items read for this check. */
  owned_items: number;
  filters: { item_ids?: string[]; avatar?: string };
  /** `item_ids` that are neither owned now nor in the previous baseline. */
  unknown_item_ids?: string[];
  warnings: string[];
  note: string;
}

interface Reported {
  readonly changed: UpdatedItem[];
  readonly new_items: NewOwnedItem[];
  /** Changed / new ids left out by the avatar filter: their baseline entry is not advanced. */
  readonly unreported: ReadonlySet<string>;
  readonly status?: MetadataStatus;
}

/**
 * Compares the library + gifts download files with the baseline of the previous check (PLAN Phase 5,
 * omnooth `outdated`), then records the current listing as the next baseline. BOOTH is only read (GET);
 * the only write is the local baseline file.
 */
export async function checkUpdates(ctx: ServiceContext, input: UpdateCheckInput = {}): Promise<BoothResult<UpdateCheckResult>> {
  const itemIds = validateItemIds(input.itemIds);
  const avatar = input.avatar === undefined ? undefined : normalizeAvatarQuery(input.avatar);
  const dictionary = avatar === undefined ? undefined : await loadDictionary(ctx);
  const filters = { ...(itemIds ? { item_ids: itemIds } : {}), ...(avatar !== undefined ? { avatar } : {}) };
  const owned = await collectOwnedItems(ctx);
  if (owned.truncated) return wrap(incompleteResult(owned, filters), LIBRARY_URL);

  const current = buildSnapshot(owned.items, new Date());
  const loaded = await loadSnapshot(ctx.updateSnapshotFile);
  const diff = diffSnapshots(loaded.snapshot, current, { itemIds });
  const reported: Reported =
    avatar !== undefined && dictionary
      ? await filterForAvatar(ctx, owned, diff, avatar, dictionary)
      : { changed: [...diff.changed], new_items: [...diff.new_items], unreported: new Set<string>() };
  const saveError = await saveBaseline(ctx, loaded.snapshot, current, itemIds, reported.unreported);
  const warnings = [...(loaded.corrupt ? [CORRUPT_WARNING] : []), ...(saveError ? [saveError] : [])];
  const result: UpdateCheckResult = {
    first_run: diff.first_run,
    complete: true,
    changed: reported.changed,
    new_items: reported.new_items,
    removed_items: [...diff.removed_items],
    unchanged_count: diff.unchanged_count,
    previous_snapshot_taken_at: loaded.snapshot?.taken_at ?? null,
    snapshot_taken_at: current.taken_at,
    snapshot_saved: saveError === undefined,
    owned_items: owned.items.length,
    filters,
    ...(itemIds ? { unknown_item_ids: unknownIds(itemIds, loaded.snapshot, current) } : {}),
    ...(reported.status ?? {}),
    warnings,
    note: resultNote(diff, loaded.snapshot, owned.items.length, avatar !== undefined),
  };
  return wrap(result, LIBRARY_URL);
}

function validateItemIds(ids: readonly (string | number)[] | undefined): string[] | undefined {
  if (ids === undefined) return undefined;
  if (ids.length === 0 || ids.length > MAX_UPDATE_ITEM_IDS) {
    throw invalidInput(`item_ids は 1〜${MAX_UPDATE_ITEM_IDS} 件の商品 ID で指定してください。`);
  }
  return [...new Set(ids.map((id) => toItemId(typeof id === "string" ? id.trim() : id)))];
}

/** Metadata for changed / new items only (at most LIST_MAX_FETCH requests; changed ones re-fetched). */
async function filterForAvatar(
  ctx: ServiceContext,
  owned: OwnedItems,
  diff: SnapshotDiff,
  avatar: string,
  dictionary: AvatarDictionary,
): Promise<Reported> {
  const changedIds = diff.changed.map((entry) => entry.item_id);
  const candidates = [...changedIds, ...diff.new_items.map((entry) => entry.item_id)];
  const batch = await fetchOwnedMetadata(ctx, owned, candidates, LIST_MAX_FETCH, changedIds);
  const files = new Map(owned.items.map((item) => [item.item_id, ownedFileNames(item.downloadables)]));
  const supported = (id: string): CompatibilityCheck | undefined => {
    const raw = batch.items.get(id);
    if (!raw) return undefined;
    const check = checkCompatibility(raw, avatar, dictionary, { ownedFileNames: files.get(id) ?? [] });
    return check.result === "supported" ? check : undefined;
  };
  const changed = withCompatibility(diff.changed, supported);
  const newItems = withCompatibility(diff.new_items, supported);
  const kept = new Set([...changed, ...newItems].map((entry) => entry.item_id));
  return { changed, new_items: newItems, unreported: new Set(candidates.filter((id) => !kept.has(id))), status: metadataStatus(batch) };
}

function withCompatibility<T extends ItemRef>(
  entries: readonly T[],
  supported: (id: string) => CompatibilityCheck | undefined,
): Array<T & { compatibility: CompatibilityCheck }> {
  return entries.flatMap((entry) => {
    const compatibility = supported(entry.item_id);
    return compatibility ? [{ ...entry, compatibility }] : [];
  });
}

/** Writes the next baseline; returns the (path-free) error message when it cannot be written. */
async function saveBaseline(
  ctx: ServiceContext,
  previous: LibrarySnapshot | null,
  current: LibrarySnapshot,
  itemIds: readonly string[] | undefined,
  unreported: ReadonlySet<string>,
): Promise<string | undefined> {
  const everything = (): string[] => [...new Set([...Object.keys(previous?.items ?? {}), ...Object.keys(current.items)])];
  const scope = unreported.size === 0 ? itemIds : (itemIds ?? everything()).filter((id) => !unreported.has(id));
  try {
    await saveSnapshot(mergeSnapshot(previous, current, { itemIds: scope }), ctx.updateSnapshotFile);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "ライブラリのスナップショットを書き込めませんでした。";
  }
}

function unknownIds(itemIds: readonly string[], previous: LibrarySnapshot | null, current: LibrarySnapshot): string[] {
  return itemIds.filter((id) => !(id in current.items) && !(previous !== null && id in previous.items));
}

function resultNote(diff: SnapshotDiff, previous: LibrarySnapshot | null, ownedCount: number, filtered: boolean): string {
  if (diff.first_run) {
    return (
      `初回の確認のため比較対象がありません。現在のライブラリとギフト（${ownedCount} 件）のダウンロードファイル構成を基準として記録しました。` +
      "次回からは、この基準（前回の確認）との差分を返します。"
    );
  }
  const base =
    `前回の確認（${previous?.taken_at ?? "-"}）からのダウンロードファイル構成の変化です。` +
    "added_files（新しいファイル）は商品の更新を示すことが多いです。今回の一覧を次回の基準として記録しました。";
  return filtered ? `${base}avatar で除外した変更は次回の確認でも報告します。${HEURISTIC_NOTE}` : base;
}

function incompleteResult(owned: OwnedItems, filters: UpdateCheckResult["filters"]): UpdateCheckResult {
  return {
    first_run: false,
    complete: false,
    changed: [],
    new_items: [],
    removed_items: [],
    unchanged_count: 0,
    previous_snapshot_taken_at: null,
    snapshot_taken_at: null,
    snapshot_saved: false,
    owned_items: owned.items.length,
    filters,
    warnings: [INCOMPLETE_WARNING],
    note: INCOMPLETE_WARNING,
  };
}
