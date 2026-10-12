import { ACCOUNTS_ORIGIN } from "../browser/url-policy.js";
import type { BoothResult } from "../types.js";
import {
  matchLibraryToProject,
  scanUnityProject,
  type UnityLibraryMatch,
  type UnityPackageRef,
} from "../unity/unity-check.js";
import type { ServiceContext } from "./context.js";
import { collectOwnedWithFree } from "./library.js";
import { wrap } from "./result.js";

const LIBRARY_URL = `${ACCOUNTS_ORIGIN}/library`;
/** Registry versions (`1.2.3`, `2.0.0-preview.3`); anything else is a location and is masked. */
const PLAIN_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;
const GIT_LOCATION = /^(?:git\+|git@|git:\/\/|ssh:\/\/|https?:\/\/)|\.git(?:[?#].*)?$/iu;
const NOTE =
  "フォルダ名・ファイル名・パッケージ ID からの推定です（ファイルの中身は読んでいません）。" +
  "confidence が low / medium の一致は商品ページやフォルダの中身で確認してください。";

/** CLI `unity-check` output (PLAN §3.5.8). Not an MCP tool: Claude can combine booth-mcp with a Unity MCP. */
export interface UnityCheckResult {
  /** Owned items found in the project (best match per item). */
  matches: UnityLibraryMatch[];
  /** Non-generic `Assets/` folders without a library match. */
  unmatched_asset_folders: string[];
  vpm_packages: UnityPackageRef[];
  /** `Packages/manifest.json` dependencies; `file:` paths become `local`, git URLs `git`. */
  upm_packages: UnityPackageRef[];
  asset_folder_count: number;
  /** Library, gift and free-download items compared. */
  owned_items: number;
  /** The library walk hit the page cap: items beyond it were not compared. */
  truncated: boolean;
  note: string;
}

/**
 * Which purchased items are in a Unity project: reads `Assets/` folder names and the package manifests
 * (validated before any BOOTH request), then compares them with the owned library + gifts + free downloads.
 */
export async function checkUnityProject(ctx: ServiceContext, projectPath: string): Promise<BoothResult<UnityCheckResult>> {
  const scan = await scanUnityProject(projectPath);
  const owned = await collectOwnedWithFree(ctx);
  const result = matchLibraryToProject(scan, owned.items);
  return wrap(
    {
      matches: [...result.matches],
      unmatched_asset_folders: [...result.unmatched_asset_folders],
      vpm_packages: [...scan.vpm_packages],
      upm_packages: scan.upm_packages.map((entry) => ({ id: entry.id, version: maskPackageVersion(entry.version) })),
      asset_folder_count: scan.asset_folders.length,
      owned_items: owned.items.length,
      truncated: owned.truncated,
      note: NOTE,
    },
    LIBRARY_URL,
  );
}

/**
 * UPM dependency values can be local paths (`file:C:/Users/<name>/…`) or git URLs (possibly private
 * hosts or tokens). Only registry versions are shown as is; locations become `local` or `git`.
 */
export function maskPackageVersion(version: string): string {
  const value = version.trim();
  if (/^file:/iu.test(value)) return "local";
  if (GIT_LOCATION.test(value)) return "git";
  return PLAIN_VERSION.test(value) ? value : "local";
}
