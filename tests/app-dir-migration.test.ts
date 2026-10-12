import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateLegacyAppDir } from "../src/app-dir-migration.js";
import { APP_DIR_NAME, getAppDir, getSessionFile, LEGACY_APP_DIR_NAME, PATH_OVERRIDE_ENV_VARS } from "../src/profile.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

/** A temp folder standing in for LOCALAPPDATA (Windows) or XDG_CONFIG_HOME (Linux). */
async function tempParent(): Promise<{ parent: string; env: NodeJS.ProcessEnv; legacy: string; current: string }> {
  const parent = await mkdtemp(join(tmpdir(), "avatar-closet-mcp-migrate-"));
  tempPaths.push(parent);
  const env = process.platform === "win32" ? { LOCALAPPDATA: parent } : { XDG_CONFIG_HOME: parent };
  return { parent, env, legacy: join(parent, LEGACY_APP_DIR_NAME), current: join(parent, APP_DIR_NAME) };
}

async function seedLegacy(legacy: string): Promise<void> {
  await mkdir(join(legacy, "cache", "items"), { recursive: true });
  await writeFile(join(legacy, "session.json"), '{"cookies":[]}', "utf8");
}

function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: operation not permitted, rename 'C:\\Users\\taro\\secret'`), { code });
}

// darwin derives the parent folder from the home directory only, so it cannot be pointed at a temp folder here.
describe.skipIf(process.platform === "darwin")("legacy app directory migration", () => {
  it("renames booth-library-mcp to avatar-closet-mcp and keeps its contents", async () => {
    const { env, legacy, current } = await tempParent();
    await seedLegacy(legacy);
    const warn = vi.fn();

    const result = await migrateLegacyAppDir(env, { warn });

    expect(result).toEqual({ status: "migrated" });
    expect(existsSync(legacy)).toBe(false);
    expect(await readFile(join(current, "session.json"), "utf8")).toBe('{"cookies":[]}');
    expect(existsSync(join(current, "cache", "items"))).toBe(true);
    expect(getAppDir(env)).toBe(current);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does nothing when avatar-closet-mcp already exists (the legacy folder is left alone)", async () => {
    const { env, legacy, current } = await tempParent();
    await seedLegacy(legacy);
    await mkdir(current);
    const move = vi.fn(rename);

    const result = await migrateLegacyAppDir(env, { rename: move, warn: vi.fn() });

    expect(result).toEqual({ status: "skipped", reason: "already-migrated" });
    expect(move).not.toHaveBeenCalled();
    expect(existsSync(join(legacy, "session.json"))).toBe(true);
    expect(getAppDir(env)).toBe(current);
  });

  it("does nothing when there is no legacy folder", async () => {
    const { env, current } = await tempParent();
    const move = vi.fn(rename);

    expect(await migrateLegacyAppDir(env, { rename: move, warn: vi.fn() })).toEqual({ status: "skipped", reason: "nothing-to-migrate" });
    expect(move).not.toHaveBeenCalled();
    expect(existsSync(current)).toBe(false);
    expect(getAppDir(env)).toBe(current);
  });

  it.each(PATH_OVERRIDE_ENV_VARS)("never migrates when %s is set", async (name) => {
    const { parent, env, legacy, current } = await tempParent();
    await seedLegacy(legacy);
    const move = vi.fn(rename);

    const result = await migrateLegacyAppDir({ ...env, [name]: join(parent, "custom") }, { rename: move, warn: vi.fn() });

    expect(result).toEqual({ status: "skipped", reason: "env-override" });
    expect(move).not.toHaveBeenCalled();
    expect(existsSync(join(legacy, "session.json"))).toBe(true);
    expect(existsSync(current)).toBe(false);
  });

  it.each(["EPERM", "EBUSY", "EXDEV"])(
    "keeps using the legacy folder for this run and warns once without paths when the rename fails (%s)",
    async (code) => {
      const { parent, env, legacy, current } = await tempParent();
      await seedLegacy(legacy);
      const warn = vi.fn();

      const result = await migrateLegacyAppDir(env, { rename: () => Promise.reject(errnoError(code)), warn });

      expect(result).toEqual({ status: "failed", code });
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toContain(`${LEGACY_APP_DIR_NAME} から ${APP_DIR_NAME}`);
      expect(message).toContain(code);
      expect(message).not.toContain(parent);
      expect(message).not.toContain("taro");
      expect(existsSync(current)).toBe(false);
      expect(getAppDir(env)).toBe(legacy);
      expect(getSessionFile(env)).toBe(join(legacy, "session.json"));
    },
  );

  it("stays silent when another process moved the folder first", async () => {
    const { env, legacy, current } = await tempParent();
    await seedLegacy(legacy);
    const warn = vi.fn();
    const raced = async (from: string, to: string): Promise<void> => {
      await rename(from, to);
      throw errnoError("ENOENT");
    };

    expect(await migrateLegacyAppDir(env, { rename: raced, warn })).toEqual({ status: "skipped", reason: "already-migrated" });
    expect(warn).not.toHaveBeenCalled();
    expect(getAppDir(env)).toBe(current);
  });
});
