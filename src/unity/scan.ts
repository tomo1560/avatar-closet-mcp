/**
 * Read-only scan of a Unity project (PLAN §3.5.8 `unity-check`): only directory names under
 * `Assets/` (two levels) and the package manifests are read — never asset file contents.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { BoothError } from "../errors.js";
import type { UnityPackageRef, UnityProjectScan } from "./types.js";

const MAX_PATH_LENGTH = 4_096;

/** Only the fields that are used are validated; other keys (e.g. `locked[id].dependencies`) are stripped. */
const vpmManifestSchema = z.object({
  dependencies: z.record(z.string(), z.object({ version: z.string() })).optional(),
  locked: z.record(z.string(), z.object({ version: z.string() })).optional(),
});

const upmManifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
});

/**
 * Scans `<projectPath>/Assets/` folder names (first and second level) and
 * `Packages/vpm-manifest.json` / `Packages/manifest.json`. Throws INVALID_INPUT when the path is
 * not a Unity project (needs `Assets/` plus `ProjectSettings/` or `Packages/`), when a manifest is
 * malformed, or when `Assets/` cannot be listed. Error messages never contain the path.
 */
export async function scanUnityProject(projectPath: string): Promise<UnityProjectScan> {
  const root = await resolveProjectRoot(projectPath);
  const assetFolders = await listAssetFolders(join(root, "Assets"));
  const vpmPackages = await readVpmPackages(join(root, "Packages", "vpm-manifest.json"));
  const vpmIds = new Set(vpmPackages.map((entry) => entry.id));
  const upmPackages = (await readUpmPackages(join(root, "Packages", "manifest.json"))).filter((entry) => !vpmIds.has(entry.id));
  return { asset_folders: assetFolders, vpm_packages: vpmPackages, upm_packages: upmPackages };
}

async function resolveProjectRoot(projectPath: string): Promise<string> {
  if (typeof projectPath !== "string" || projectPath.trim() === "" || projectPath.length > MAX_PATH_LENGTH || projectPath.includes("\0")) {
    throw invalidInput("Unity プロジェクトのフォルダのパスを指定してください。");
  }
  const root = resolve(projectPath.trim());
  if (!(await isDirectory(root))) throw invalidInput("指定された Unity プロジェクトのフォルダが見つかりません。");
  const hasAssets = await isDirectory(join(root, "Assets"));
  const hasProjectFolder = (await isDirectory(join(root, "ProjectSettings"))) || (await isDirectory(join(root, "Packages")));
  if (!hasAssets || !hasProjectFolder) {
    throw invalidInput("指定されたフォルダは Unity プロジェクトではありません（Assets/ と ProjectSettings/ または Packages/ が必要です）。");
  }
  return root;
}

async function listAssetFolders(assetsDir: string): Promise<string[]> {
  const topLevel = await listChildFolders(assetsDir);
  const nested = await Promise.all(
    topLevel.map(async (name) => (await listChildFolders(join(assetsDir, name))).map((child) => `${name}/${child}`)),
  );
  return [...topLevel, ...nested.flat()].sort();
}

/** Names of real sub-directories; symlinks / junctions, dot folders and `~` folders (ignored by Unity) are skipped. */
async function listChildFolders(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !isHiddenFolder(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    // A folder removed while scanning is simply gone.
    if (errorCode(error) === "ENOENT") return [];
    throw invalidInput(`Assets/ 内のフォルダを読み取れませんでした（${errorCode(error)}）。`);
  }
}

function isHiddenFolder(name: string): boolean {
  return name.startsWith(".") || name.endsWith("~");
}

async function readVpmPackages(file: string): Promise<UnityPackageRef[]> {
  const manifest = await readManifest(file, "Packages/vpm-manifest.json", vpmManifestSchema);
  if (!manifest) return [];
  const versions = new Map<string, string>();
  for (const [id, entry] of Object.entries(manifest.dependencies ?? {})) versions.set(id, entry.version);
  for (const [id, entry] of Object.entries(manifest.locked ?? {})) versions.set(id, entry.version);
  return toPackageRefs(versions);
}

async function readUpmPackages(file: string): Promise<UnityPackageRef[]> {
  const manifest = await readManifest(file, "Packages/manifest.json", upmManifestSchema);
  return manifest ? toPackageRefs(new Map(Object.entries(manifest.dependencies ?? {}))) : [];
}

/** Parsed manifest, `null` when the file does not exist. */
async function readManifest<T>(file: string, label: string, schema: z.ZodType<T>): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw invalidInput(`${label} を読み取れませんでした（${errorCode(error)}）。`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw invalidInput(`${label} が JSON として読み取れません。`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw invalidInput(`${label} の形式が想定と異なります。`);
  return parsed.data;
}

function toPackageRefs(versions: ReadonlyMap<string, string>): UnityPackageRef[] {
  return [...versions.entries()].map(([id, version]) => ({ id, version })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return "unknown error";
}

function invalidInput(message: string): BoothError {
  return new BoothError("INVALID_INPUT", message);
}
