import { lstat, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/** Written by login only into a profile directory it created itself. */
export const PROFILE_MARKER_FILE = "avatar-closet-mcp-profile.json";
export const DEFAULT_PROFILE_DIR_NAME = "browser-profile";

export interface ProfileDirPaths {
  readonly appDir: string;
  readonly sessionFile: string;
  readonly profileDir: string;
  /** Item cache; a profile directory that contains it is never deleted. */
  readonly cacheDir: string;
}

export type ProfileRemoval = { readonly removed: true } | { readonly removed: false; readonly warning?: string };

/** Creates the login profile directory (0700) and marks it as ours if it did not exist before. */
export async function prepareProfileDir(profileDir: string): Promise<void> {
  const existed = await pathExists(profileDir);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  if (!existed) {
    await writeFile(join(profileDir, PROFILE_MARKER_FILE), `${JSON.stringify({ createdBy: "avatar-closet-mcp" })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

/**
 * Recursively deletes the login browser profile (it holds pixiv cookies), but only when it is
 * provably ours: it must carry PROFILE_MARKER_FILE (written by login into a directory it created),
 * and a custom location must also look like a Chromium profile (`Local State` or `Default/`).
 * Symlinks and any directory that is, or contains, the filesystem root, the home directory, the app
 * directory, the cache directory, the session file's directory or the working directory are refused.
 */
export async function removeProfileDir(paths: ProfileDirPaths): Promise<ProfileRemoval> {
  const profileDir = resolve(paths.profileDir);
  const refusal = await refusalReason(profileDir, paths);
  if (refusal === "missing") return { removed: false };
  if (refusal) return { removed: false, warning: `ブラウザプロファイルを削除しませんでした（${refusal}）。必要なら手動で削除してください。` };
  try {
    // maxRetries: Chrome may still hold file locks on Windows right after the login window closes.
    await rm(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    return { removed: true };
  } catch {
    return { removed: false, warning: "ブラウザプロファイルを削除できませんでした。ログイン用ブラウザを閉じてから再実行してください。" };
  }
}

async function refusalReason(profileDir: string, paths: ProfileDirPaths): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(profileDir);
  } catch {
    return "missing";
  }
  if (info.isSymbolicLink()) return "シンボリックリンクです";
  if (!info.isDirectory()) return "ディレクトリではありません";
  if (await containsProtectedPath(profileDir, paths)) return "保護されたディレクトリかその親ディレクトリです";
  if (!(await pathExists(join(profileDir, PROFILE_MARKER_FILE)))) return "avatar-closet-mcp が作成したプロファイルではありません";
  if (isDefaultProfileDir(profileDir, paths)) return undefined;
  if (!(await looksLikeChromiumProfile(profileDir))) return "Chromium のプロファイルに見えません";
  return undefined;
}

/** True when the profile directory is, or is an ancestor of, a path that must survive (lexically or via links). */
async function containsProtectedPath(profileDir: string, paths: ProfileDirPaths): Promise<boolean> {
  const protectedPaths = [
    parse(profileDir).root,
    homedir(),
    paths.appDir,
    paths.cacheDir,
    dirname(resolve(paths.sessionFile)),
    process.cwd(),
  ];
  const profiles = await withRealPath(profileDir);
  for (const candidate of protectedPaths) {
    const targets = await withRealPath(candidate);
    if (profiles.some((profile) => targets.some((target) => isSameOrInside(profile, target)))) return true;
  }
  return false;
}

function isDefaultProfileDir(profileDir: string, paths: ProfileDirPaths): boolean {
  return comparable(profileDir) === comparable(join(resolve(paths.appDir), DEFAULT_PROFILE_DIR_NAME));
}

/** The resolved path plus its real path when it exists (symlinked or 8.3-short ancestors). */
async function withRealPath(path: string): Promise<string[]> {
  const resolved = resolve(path);
  try {
    return [resolved, await realpath(resolved)];
  } catch {
    return [resolved];
  }
}

/** `candidate` is `ancestor` itself or lies inside it (case-insensitive on Windows and macOS). */
function isSameOrInside(ancestor: string, candidate: string): boolean {
  const rel = relative(comparable(ancestor), comparable(candidate));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function comparable(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
}

async function looksLikeChromiumProfile(profileDir: string): Promise<boolean> {
  if (await pathExists(join(profileDir, "Local State"))) return true;
  try {
    return (await stat(join(profileDir, "Default"))).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
