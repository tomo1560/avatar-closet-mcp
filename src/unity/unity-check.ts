/**
 * `unity-check <projectPath>` (PLAN §3.5.8): which purchased BOOTH items are in a Unity project.
 * {@link scanUnityProject} reads folder names and package manifests only; {@link matchLibraryToProject}
 * is pure and compares the scan with the library listing.
 */
export { isGenericAssetFolder, normalizeAssetName } from "./asset-name.js";
export { matchLibraryToProject } from "./match.js";
export { scanUnityProject } from "./scan.js";
export type {
  UnityLibraryMatch,
  UnityMatchResult,
  UnityMatchSource,
  UnityPackageRef,
  UnityProjectScan,
} from "./types.js";
