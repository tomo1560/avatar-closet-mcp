import { homedir } from "node:os";
import { join } from "node:path";

const APP_DIR_NAME = "avatar-closet-mcp";

export function getAppDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BOOTH_MCP_HOME) return env.BOOTH_MCP_HOME;

  if (process.platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), APP_DIR_NAME);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_DIR_NAME);
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), APP_DIR_NAME);
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
