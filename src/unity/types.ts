import type { Confidence } from "../vrchat/types.js";

export interface UnityPackageRef {
  readonly id: string;
  readonly version: string;
}

/** Result of {@link scanUnityProject}: folder names and package ids only, never file contents. */
export interface UnityProjectScan {
  /**
   * Directory names under `Assets/`, first and second level, as `/`-joined relative paths
   * (`"Shinano"`, `"Shinano/Prefabs"`), sorted. Dot folders, `~` folders and symlinks are skipped.
   */
  readonly asset_folders: readonly string[];
  /** `Packages/vpm-manifest.json`: `locked` versions win over `dependencies`. Sorted by id. */
  readonly vpm_packages: readonly UnityPackageRef[];
  /** `Packages/manifest.json` dependencies not already in `vpm_packages`. Sorted by id. */
  readonly upm_packages: readonly UnityPackageRef[];
}

export type UnityMatchSource = "asset_folder" | "file_name" | "vpm_package";

export interface UnityLibraryMatch {
  readonly item_id: string;
  readonly name: string;
  readonly matched_by: UnityMatchSource;
  /** `<project side> ↔ <library side>`, e.g. `Assets/Shinano ↔ Shinano_v1.0.2.unitypackage`. */
  readonly evidence: string;
  readonly confidence: Confidence;
}

export interface UnityMatchResult {
  /** One entry per library item (its best match), sorted by confidence then item id. */
  readonly matches: readonly UnityLibraryMatch[];
  /** Non-generic asset folders without any library match (see `matchLibraryToProject`). */
  readonly unmatched_asset_folders: readonly string[];
}
