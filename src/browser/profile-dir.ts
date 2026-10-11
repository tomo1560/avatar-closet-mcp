import { lstat, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

/** Written by login only into a profile directory it created itself. */
export const PROFILE_MARKER_FILE = "booth-library-mcp-profile.json";
export const DEFAULT_PROFILE_DIR_NAME = "browser-profile";

export interface ProfileDirPaths {
  readonly appDir: string;
  readonly sessionFile: string;
  readonly profileDir: string;
}

export type ProfileRemoval = { readonly removed: true } | { readonly removed: false; readonly warning?: string };

/** Creates the login profile directory (0700) and marks it as ours if it did not exist before. */
export async function prepareProfileDir(profileDir: string): Promise<void> {
  const existed = await pathExists(profileDir);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  if (!existed) {
    await writeFile(join(profileDir, PROFILE_MARKER_FILE), `${JSON.stringify({ createdBy: "booth-library-mcp" })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

/**
 * Recursively deletes the login browser profile (it holds pixiv cookies), but only when it is
 * provably ours: the default `<appDir>/browser-profile`, or a custom directory that is both a
 * Chromium profile (`Local State` or `Default/`) and carries PROFILE_MARKER_FILE. Symlinks,
 * filesystem roots, the home directory, the app directory, and the working directory are refused.
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
  if (isProtectedPath(profileDir, paths)) return "保護されたディレクトリです";
  if (samePath(profileDir, join(resolve(paths.appDir), DEFAULT_PROFILE_DIR_NAME))) return undefined;
  if (!(await pathExists(join(profileDir, PROFILE_MARKER_FILE)))) return "booth-library-mcp が作成したプロファイルではありません";
  if (!(await looksLikeChromiumProfile(profileDir))) return "Chromium のプロファイルに見えません";
  return undefined;
}

function isProtectedPath(profileDir: string, paths: ProfileDirPaths): boolean {
  const protectedPaths = [parse(profileDir).root, homedir(), paths.appDir, dirname(resolve(paths.sessionFile)), process.cwd()];
  return protectedPaths.some((candidate) => samePath(candidate, profileDir));
}

async function looksLikeChromiumProfile(profileDir: string): Promise<boolean> {
  if (await pathExists(join(profileDir, "Local State"))) return true;
  try {
    return (await stat(join(profileDir, "Default"))).isDirectory();
  } catch {
    return false;
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
