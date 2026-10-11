import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearLocalLogin, getLocalLoginPaths } from "../src/browser/logout.js";
import { PROFILE_MARKER_FILE, prepareProfileDir } from "../src/browser/profile-dir.js";
import { getCacheDir, getSessionFile } from "../src/profile.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("logout (local credential cleanup)", () => {
  it("deletes session.json and the default browser profile that login created", async () => {
    const appDir = await createTempDirectory();
    const paths = defaultPaths(appDir);
    await writeFile(paths.sessionFile, "{}", "utf8");
    await prepareProfileDir(paths.profileDir);
    await mkdir(join(paths.profileDir, "Default"), { recursive: true });
    await writeFile(join(paths.profileDir, "Default", "Cookies"), "fictional", "utf8");

    const result = await clearLocalLogin(paths);

    expect(result).toEqual({ sessionFileRemoved: true, profileDirRemoved: true, warnings: [] });
    expect(await exists(paths.sessionFile)).toBe(false);
    expect(await exists(paths.profileDir)).toBe(false);
    expect(await exists(appDir)).toBe(true);
  });

  it("deletes a default profile with only the marker (login aborted before the browser started)", async () => {
    const appDir = await createTempDirectory();
    const paths = defaultPaths(appDir);
    await prepareProfileDir(paths.profileDir);
    expect((await clearLocalLogin(paths)).profileDirRemoved).toBe(true);
  });

  it("refuses the default path without the marker and asks the user to delete it manually", async () => {
    const appDir = await createTempDirectory();
    const paths = defaultPaths(appDir);
    await mkdir(join(paths.profileDir, "Default"), { recursive: true });
    await writeFile(join(paths.profileDir, "Local State"), "{}", "utf8");

    const result = await clearLocalLogin(paths);

    expect(result.profileDirRemoved).toBe(false);
    expect(result.warnings).toEqual([expect.stringContaining("手動で削除")]);
    expect(result.warnings[0]).not.toContain(appDir);
    expect(await exists(join(paths.profileDir, "Local State"))).toBe(true);
  });

  it.each([
    ["the cache directory", (profileDir: string, appDir: string) => ({ ...defaultPaths(appDir), profileDir, cacheDir: join(profileDir, "cache") })],
    ["the session file", (profileDir: string, appDir: string) => ({ ...defaultPaths(appDir), profileDir, sessionFile: join(profileDir, "nested", "session.json") })],
    ["the app directory", (profileDir: string) => ({ ...defaultPaths(join(profileDir, "app")), profileDir })],
  ])("refuses a marked profile that contains %s", async (_label, makePaths) => {
    const appDir = await createTempDirectory();
    const profileDir = await createTempDirectory();
    await writeFile(join(profileDir, PROFILE_MARKER_FILE), "{}", "utf8");
    await writeFile(join(profileDir, "Local State"), "{}", "utf8");

    const result = await clearLocalLogin(makePaths(profileDir, appDir));

    expect(result.profileDirRemoved).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(await exists(join(profileDir, "Local State"))).toBe(true);
  });

  it("deletes a custom Chromium profile dir that booth-library-mcp created", async () => {
    const appDir = await createTempDirectory();
    const profileDir = join(await createTempDirectory(), "custom-profile");
    await prepareProfileDir(profileDir);
    await writeFile(join(profileDir, "Local State"), "{}", "utf8");

    const result = await clearLocalLogin({ ...defaultPaths(appDir), profileDir });

    expect(result.profileDirRemoved).toBe(true);
    expect(await exists(profileDir)).toBe(false);
  });

  it("refuses a Chromium profile it did not create (e.g. the user's real Chrome User Data)", async () => {
    const appDir = await createTempDirectory();
    const realProfile = await createTempDirectory();
    await writeFile(join(realProfile, "Local State"), "{}", "utf8");
    await mkdir(join(realProfile, "Default"));

    const result = await clearLocalLogin({ ...defaultPaths(appDir), profileDir: realProfile });

    expect(result.profileDirRemoved).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(await exists(join(realProfile, "Local State"))).toBe(true);
  });

  it("marks only directories it creates", async () => {
    const existing = await createTempDirectory();
    await prepareProfileDir(existing);
    expect(await exists(join(existing, PROFILE_MARKER_FILE))).toBe(false);
    const created = join(existing, "new-profile");
    await prepareProfileDir(created);
    expect(await exists(join(created, PROFILE_MARKER_FILE))).toBe(true);
  });

  it("refuses to delete a custom directory that is not a browser profile, but still removes the session", async () => {
    const appDir = await createTempDirectory();
    const sessionFile = join(appDir, "session.json");
    await writeFile(sessionFile, "{}", "utf8");
    const notAProfile = await createTempDirectory();
    await writeFile(join(notAProfile, "important.txt"), "keep me", "utf8");

    const result = await clearLocalLogin({ ...defaultPaths(appDir), sessionFile, profileDir: notAProfile });

    expect(result.sessionFileRemoved).toBe(true);
    expect(result.profileDirRemoved).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(await readdir(notAProfile)).toEqual(["important.txt"]);
  });

  it("refuses to delete the app directory itself even if it contains profile markers", async () => {
    const appDir = await createTempDirectory();
    await writeFile(join(appDir, "Local State"), "{}", "utf8");
    await writeFile(join(appDir, "avatars.json"), "[]", "utf8");

    const result = await clearLocalLogin({ ...defaultPaths(appDir), profileDir: appDir });

    expect(result.profileDirRemoved).toBe(false);
    expect(await exists(join(appDir, "avatars.json"))).toBe(true);
  });

  it("refuses to follow a symlinked profile dir", async () => {
    const appDir = await createTempDirectory();
    const target = await createTempDirectory();
    await writeFile(join(target, "Local State"), "{}", "utf8");
    const profileDir = join(appDir, "browser-profile");
    await symlink(target, profileDir, process.platform === "win32" ? "junction" : "dir");

    const result = await clearLocalLogin({ ...defaultPaths(appDir), profileDir });

    expect(result.profileDirRemoved).toBe(false);
    expect(await exists(join(target, "Local State"))).toBe(true);
  });

  it("succeeds when nothing exists", async () => {
    const appDir = join(await createTempDirectory(), "never-created");
    const result = await clearLocalLogin(defaultPaths(appDir));
    expect(result).toEqual({ sessionFileRemoved: false, profileDirRemoved: false, warnings: [] });
  });
});

describe("local login paths", () => {
  it("keeps session.json in the app directory even with a custom profile directory", () => {
    const env = { BOOTH_MCP_HOME: join("x", "app"), BOOTH_MCP_PROFILE_DIR: join("y", "profile") };
    expect(getSessionFile(env)).toBe(join("x", "app", "session.json"));
    expect(getSessionFile({ ...env, BOOTH_MCP_SESSION_FILE: join("z", "s.json") })).toBe(join("z", "s.json"));
  });

  it("includes the cache directory", () => {
    const env = { BOOTH_MCP_HOME: join("x", "app") };
    expect(getLocalLoginPaths(env)).toEqual({
      appDir: join("x", "app"),
      sessionFile: join("x", "app", "session.json"),
      profileDir: join("x", "app", "browser-profile"),
      cacheDir: getCacheDir(env),
    });
  });
});

function defaultPaths(appDir: string): { appDir: string; sessionFile: string; profileDir: string; cacheDir: string } {
  return {
    appDir,
    sessionFile: join(appDir, "session.json"),
    profileDir: join(appDir, "browser-profile"),
    cacheDir: join(appDir, "cache"),
  };
}

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "booth-library-mcp-logout-"));
  tempPaths.push(directory);
  return directory;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
