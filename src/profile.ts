import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function getProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BOOTH_MCP_PROFILE_DIR) return env.BOOTH_MCP_PROFILE_DIR;

  if (process.platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "booth-library-mcp", "browser-profile");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "booth-library-mcp", "browser-profile");
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "booth-library-mcp", "browser-profile");
}

export function getSessionFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BOOTH_MCP_SESSION_FILE) return env.BOOTH_MCP_SESSION_FILE;
  return join(dirname(getProfileDir(env)), "session.json");
}
