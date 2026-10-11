import { getAppDir, getProfileDir, getSessionFile } from "../profile.js";
import { deleteSessionFile } from "../session-state.js";
import type { LogoutResult } from "../types.js";
import { removeProfileDir, type ProfileDirPaths } from "./profile-dir.js";

export function getLocalLoginPaths(env: NodeJS.ProcessEnv = process.env): ProfileDirPaths {
  return { appDir: getAppDir(env), sessionFile: getSessionFile(env), profileDir: getProfileDir(env) };
}

/**
 * Removes every local credential: session.json (BOOTH cookies) and the login browser profile
 * (which also holds pixiv cookies). Missing files are not an error. Paths are never returned
 * because they contain the OS user name.
 */
export async function clearLocalLogin(paths: ProfileDirPaths = getLocalLoginPaths()): Promise<LogoutResult> {
  const sessionFileRemoved = await deleteSessionFile(paths.sessionFile);
  const profile = await removeProfileDir(paths);
  return {
    sessionFileRemoved,
    profileDirRemoved: profile.removed,
    warnings: !profile.removed && profile.warning ? [profile.warning] : [],
  };
}
