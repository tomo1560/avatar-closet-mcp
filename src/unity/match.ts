/**
 * Pure matching of a Unity project scan against the user's BOOTH library (PLAN §3.5.8).
 *
 * Asset folders (last path segment, normalised by {@link normalizeAssetName}) are compared with:
 * - high:   a downloadable file-name stem equal to the folder name (`Shinano` ↔ `Shinano_v1.0.2.unitypackage`)
 * - medium: the folder name contained in the item name (`AccessoryPack` ⊂ `Example Accessory Pack DX`)
 * - low:    a partial overlap with a file-name stem, either direction (`Kemomimi` ~ `Kemomimi_Set_PC.zip`)
 * Names shorter than 4 characters, digit-only names and generic folders (`Editor`, `Materials`, …)
 * never match. Per folder only the best-ranked candidates survive, then each item keeps its best match.
 *
 * Known VPM tool packages (`jp.lilxyzw.liltoon` → lilToon, …) match items that are the tool itself:
 * high when a file stem or the undecorated title equals a tool alias, medium when the title mentions
 * the tool other than as a dependency (`lilToon対応` / `MA用` / `… compatible` do not count).
 */
import type { LibraryItem } from "../parsers/library.js";
import type { Confidence } from "../vrchat/types.js";
import { isGenericAssetFolder, isMatchable, normalizeAssetName, normalizeItemTitle } from "./asset-name.js";
import { knownToolForPackage, type KnownTool } from "./known-packages.js";
import type { UnityLibraryMatch, UnityMatchResult, UnityMatchSource, UnityPackageRef, UnityProjectScan } from "./types.js";

const RANK: Readonly<Record<Confidence, number>> = { high: 3, medium: 2, low: 1 };
/** After a tool name in an item title, these words mean "for / with that tool", not the tool itself. */
const DEPENDENCY_CONTEXT = /^(対応|用|必須|前提|向け|版|べーす|使用|導入|専用|compatible|support|ready)/;

interface PreparedFile {
  readonly fileName: string;
  readonly stem: string;
}

interface PreparedItem {
  readonly itemId: string;
  readonly name: string;
  /** Normalised full title. */
  readonly title: string;
  /** Normalised title without bracketed decorations (`【無料】`). */
  readonly bareTitle: string;
  readonly files: readonly PreparedFile[];
}

interface PreparedFolder {
  /** Relative path under `Assets/`. */
  readonly path: string;
  readonly name: string;
}

interface Candidate {
  readonly item: PreparedItem;
  readonly matchedBy: UnityMatchSource;
  readonly confidence: Confidence;
  readonly evidence: string;
  /** Length of the matched text; longer is more specific. */
  readonly score: number;
}

export function matchLibraryToProject(scan: UnityProjectScan, libraryItems: readonly LibraryItem[]): UnityMatchResult {
  const items = prepareItems(libraryItems);
  const matchedFolders = new Set<string>();
  const folderCandidates = scan.asset_folders.flatMap((path) => {
    const folder = prepareFolder(path);
    const best = folder ? bestCandidates(items.flatMap((item) => matchFolder(folder, item) ?? [])) : [];
    if (best.length > 0) matchedFolders.add(path);
    return best;
  });
  const packageCandidates = scan.vpm_packages.flatMap((entry) => {
    const tool = knownToolForPackage(entry.id);
    return tool ? items.flatMap((item) => matchTool(entry, tool, item) ?? []) : [];
  });
  return {
    matches: bestPerItem([...folderCandidates, ...packageCandidates]),
    unmatched_asset_folders: unmatchedFolders(scan.asset_folders, matchedFolders),
  };
}

/** One entry per item id (library + gifts may repeat an item): first name, all files. */
function prepareItems(libraryItems: readonly LibraryItem[]): PreparedItem[] {
  const byId = new Map<string, PreparedItem>();
  for (const item of libraryItems) {
    const files = item.downloadables.flatMap(({ file_name }) => {
      const stem = file_name === null ? "" : normalizeAssetName(file_name);
      return file_name !== null && isMatchable(stem) ? [{ fileName: file_name, stem }] : [];
    });
    const existing = byId.get(item.item_id);
    byId.set(
      item.item_id,
      existing
        ? { ...existing, files: [...existing.files, ...files] }
        : { itemId: item.item_id, name: item.name, title: normalizeAssetName(item.name), bareTitle: normalizeItemTitle(item.name), files },
    );
  }
  return [...byId.values()];
}

/** Normalised last segment, or `null` for generic / too short folders that never match. */
function prepareFolder(path: string): PreparedFolder | null {
  const name = normalizeAssetName(lastSegment(path));
  return isMatchable(name) ? { path, name } : null;
}

function matchFolder({ path, name }: PreparedFolder, item: PreparedItem): Candidate | null {
  const project = `Assets/${path}`;
  const exact = item.files.find((file) => file.stem === name);
  if (exact) return candidate(item, "file_name", "high", project, exact.fileName, name.length);
  if (isMatchable(item.title) && item.title.includes(name)) {
    return candidate(item, "asset_folder", "medium", project, item.name, name.length);
  }
  const partial = item.files
    .filter((file) => file.stem.includes(name) || name.includes(file.stem))
    .map((file) => ({ file, score: Math.min(file.stem.length, name.length) }))
    .sort((a, b) => b.score - a.score)[0];
  return partial ? candidate(item, "file_name", "low", project, partial.file.fileName, partial.score) : null;
}

function matchTool(entry: UnityPackageRef, tool: KnownTool, item: PreparedItem): Candidate | null {
  const project = `Packages/vpm-manifest.json ${entry.id}@${entry.version}`;
  const score = Math.max(...tool.aliases.map((alias) => alias.length));
  const file = item.files.find((candidateFile) => tool.aliases.includes(candidateFile.stem));
  if (file) return candidate(item, "vpm_package", "high", project, file.fileName, score);
  if (tool.aliases.includes(item.bareTitle)) return candidate(item, "vpm_package", "high", project, item.name, score);
  if (tool.aliases.some((alias) => namesTool(item.title, alias))) {
    return candidate(item, "vpm_package", "medium", project, item.name, score);
  }
  return null;
}

/** True when `title` contains `alias` at least once without a dependency context word right after it. */
function namesTool(title: string, alias: string): boolean {
  for (let index = title.indexOf(alias); index >= 0; index = title.indexOf(alias, index + 1)) {
    if (!DEPENDENCY_CONTEXT.test(title.slice(index + alias.length))) return true;
  }
  return false;
}

function candidate(
  item: PreparedItem,
  matchedBy: UnityMatchSource,
  confidence: Confidence,
  projectSide: string,
  librarySide: string,
  score: number,
): Candidate {
  return { item, matchedBy, confidence, evidence: `${projectSide} ↔ ${librarySide}`, score };
}

/** Candidates sharing the best (confidence, score) of the list. */
function bestCandidates(candidates: readonly Candidate[]): Candidate[] {
  const top = [...candidates].sort(compareCandidates)[0];
  return top ? candidates.filter((entry) => compareCandidates(entry, top) === 0) : [];
}

function bestPerItem(candidates: readonly Candidate[]): UnityLibraryMatch[] {
  const best = new Map<string, Candidate>();
  for (const entry of candidates) {
    const current = best.get(entry.item.itemId);
    if (!current || compareCandidates(entry, current) < 0) best.set(entry.item.itemId, entry);
  }
  return [...best.values()]
    .sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || compareNumericIds(a.item.itemId, b.item.itemId))
    .map((entry) => ({
      item_id: entry.item.itemId,
      name: entry.item.name,
      matched_by: entry.matchedBy,
      evidence: entry.evidence,
      confidence: entry.confidence,
    }));
}

/** Negative when `a` is the better candidate. */
function compareCandidates(a: Candidate, b: Candidate): number {
  return RANK[b.confidence] - RANK[a.confidence] || b.score - a.score;
}

/**
 * Non-generic top-level folders without a match. When some second-level folders of a top-level
 * folder matched (a creator folder holding several items), its unmatched siblings are reported
 * instead. Generic top-level folders (`Editor`, `Avatars`, …) and matched subtrees are skipped.
 */
function unmatchedFolders(folders: readonly string[], matched: ReadonlySet<string>): string[] {
  const result = folders
    .filter((folder) => !folder.includes("/") && !matched.has(folder) && !isGenericAssetFolder(folder))
    .flatMap((top) => {
      const children = folders.filter((folder) => folder.startsWith(`${top}/`) && !isGenericAssetFolder(lastSegment(folder)));
      return children.some((child) => matched.has(child)) ? children.filter((child) => !matched.has(child)) : [top];
    });
  return result.sort();
}

function lastSegment(folder: string): string {
  return folder.slice(folder.lastIndexOf("/") + 1);
}

function compareNumericIds(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}
