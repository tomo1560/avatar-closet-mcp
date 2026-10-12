import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_DIR_NAME = "avatar-closet-mcp";
/** Folder name used before the rename to avatar-closet-mcp (PLAN §7-7); moved once by app-dir-migration.ts. */
export const LEGACY_APP_DIR_NAME = "booth-library-mcp";

/** Environment variables that relocate the app directory or one of its files; any of them disables the migration. */
export const PATH_OVERRIDE_ENV_VARS = [
  "BOOTH_MCP_HOME",
  "BOOTH_MCP_PROFILE_DIR",
  "BOOTH_MCP_SESSION_FILE",
  "BOOTH_MCP_CACHE_DIR",
  "BOOTH_MCP_AVATARS_FILE",
] as const;

/** Per-user folder that holds the app directory (LOCALAPPDATA, Application Support or XDG_CONFIG_HOME). */
export function getAppDirParent(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") return env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support");
  return env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

/**
 * The app directory: BOOTH_MCP_HOME, otherwise `<parent>/avatar-closet-mcp`. While only the legacy
 * `<parent>/booth-library-mcp` exists (the one-time migration has not run or could not rename it, e.g.
 * because another process holds a file in it), the legacy folder keeps being used so no data is lost.
 */
export function getAppDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BOOTH_MCP_HOME) return env.BOOTH_MCP_HOME;
  const parent = getAppDirParent(env);
  const current = join(parent, APP_DIR_NAME);
  const legacy = join(parent, LEGACY_APP_DIR_NAME);
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export function getProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BOOTH_MCP_PROFILE_DIR) return env.BOOTH_MCP_PROFILE_DIR;
  return join(getAppDir(env), "browser-profile");
}

/**
 * session.json lives in the app directory (not next to a custom BOOTH_MCP_PROFILE_DIR), so deleting the
 * login profile can never take the session file's directory with it.
 */
export function getSessionFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BOOTH_MCP_SESSION_FILE) return env.BOOTH_MCP_SESSION_FILE;
  return join(getAppDir(env), "session.json");
}

export function getCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BOOTH_MCP_CACHE_DIR) return env.BOOTH_MCP_CACHE_DIR;
  return join(getAppDir(env), "cache");
}

export function getAvatarDictionaryFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BOOTH_MCP_AVATARS_FILE) return env.BOOTH_MCP_AVATARS_FILE;
  return join(getAppDir(env), "avatars.json");
}
