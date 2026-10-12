import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { errnoCodeOf } from "./errors.js";
import { APP_DIR_NAME, getAppDirParent, LEGACY_APP_DIR_NAME, PATH_OVERRIDE_ENV_VARS } from "./profile.js";

export type AppDirMigrationResult =
  | { readonly status: "migrated" }
  | { readonly status: "skipped"; readonly reason: "env-override" | "already-migrated" | "nothing-to-migrate" }
  | { readonly status: "failed"; readonly code: string };

export interface AppDirMigrationDeps {
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly exists: (path: string) => boolean;
  readonly warn: (message: string) => void;
}

const DEFAULT_DEPS: AppDirMigrationDeps = {
  rename,
  exists: existsSync,
  warn: (message) => void process.stderr.write(message),
};

/**
 * One-time move of the data folder `<parent>/booth-library-mcp` to `<parent>/avatar-closet-mcp` after the
 * package rename (PLAN §7-7). Called once at CLI / MCP server startup, before any session or cache access.
 *
 * - Skipped when BOOTH_MCP_HOME or any per-file path variable is set (those paths may point into the old folder),
 *   when the new folder already exists, or when there is no old folder.
 * - Never throws. If the rename fails (EPERM / EBUSY while another process holds a file in it, EXDEV, ...), it
 *   prints one warning naming only the folder names and the errno code, and the old folder stays in use for this
 *   run: getAppDir() keeps returning it while the new folder does not exist.
 */
export async function migrateLegacyAppDir(
  env: NodeJS.ProcessEnv = process.env,
  deps: Partial<AppDirMigrationDeps> = {},
): Promise<AppDirMigrationResult> {
  const { rename: move, exists, warn } = { ...DEFAULT_DEPS, ...deps };
  if (PATH_OVERRIDE_ENV_VARS.some((name) => env[name])) return { status: "skipped", reason: "env-override" };
  const parent = getAppDirParent(env);
  const current = join(parent, APP_DIR_NAME);
  const legacy = join(parent, LEGACY_APP_DIR_NAME);
  if (exists(current)) return { status: "skipped", reason: "already-migrated" };
  if (!exists(legacy)) return { status: "skipped", reason: "nothing-to-migrate" };
  try {
    await move(legacy, current);
    return { status: "migrated" };
  } catch (error) {
    // A second process started at the same moment may have moved it first.
    if (exists(current)) return { status: "skipped", reason: "already-migrated" };
    const code = errnoCodeOf(error) ?? "UNKNOWN";
    warn(migrationWarning(code));
    return { status: "failed", code };
  }
}

function migrationWarning(code: string): string {
  return (
    `${APP_DIR_NAME}: データフォルダを ${LEGACY_APP_DIR_NAME} から ${APP_DIR_NAME} へ移行できませんでした（${code}）。` +
    `今回は ${LEGACY_APP_DIR_NAME} をそのまま使います。起動中の MCP サーバーやログイン用ブラウザを閉じてから再実行すると移行されます。\n`
  );
}
