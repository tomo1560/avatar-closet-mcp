import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoothError } from "../src/errors.js";
import {
  ADULT_COOKIE,
  loadSessionState,
  persistBoothSession,
  withAdultCookie,
  type StorageState,
  type StorageCookie,
} from "../src/session-state.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("session persistence", () => {
  it("stores only BOOTH cookies and origins and adds adult=t", async () => {
    const sessionFile = join(await createTempDirectory(), "session.json");
    const context = {
      storageState: () =>
        Promise.resolve({
          cookies: [cookie("_plaza_session_test", ".booth.pm"), cookie("PHPSESSID", ".pixiv.net"), cookie("other", ".example.com")],
          origins: [
            { origin: "https://accounts.booth.pm", localStorage: [] },
            { origin: "https://www.pixiv.net", localStorage: [] },
          ],
        }),
    };
    await persistBoothSession(context, sessionFile);
    const saved = JSON.parse(await readFile(sessionFile, "utf8")) as StorageState;
    expect(saved.cookies.map((entry) => entry.name)).toEqual(["_plaza_session_test", "adult"]);
    expect(saved.cookies.find((entry) => entry.name === "adult")).toMatchObject({ value: "t", domain: ".booth.pm", path: "/" });
    expect(saved.origins.map((entry) => entry.origin)).toEqual(["https://accounts.booth.pm"]);
  });

  it.skipIf(process.platform === "win32")("writes the session file as 0600 inside a 0700 directory", async () => {
    const directory = join(await createTempDirectory(), "nested");
    const sessionFile = join(directory, "session.json");
    await persistBoothSession({ storageState: () => Promise.resolve({ cookies: [], origins: [] }) }, sessionFile);
    expect((await stat(sessionFile)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it("writes a readable session file on every platform", async () => {
    const sessionFile = join(await createTempDirectory(), "session.json");
    await persistBoothSession({ storageState: () => Promise.resolve({ cookies: [], origins: [] }) }, sessionFile);
    expect((await stat(sessionFile)).isFile()).toBe(true);
  });
});

describe("adult cookie", () => {
  it("adds adult=t for .booth.pm when absent", () => {
    const state = withAdultCookie({ cookies: [], origins: [] });
    expect(state.cookies).toEqual([ADULT_COOKIE]);
    expect(ADULT_COOKIE).toMatchObject({ name: "adult", value: "t", domain: ".booth.pm", path: "/" });
  });

  it("replaces an existing BOOTH adult cookie without mutating the input", () => {
    const input: StorageState = { cookies: [{ ...cookie("adult", ".booth.pm"), value: "f" }], origins: [] };
    const state = withAdultCookie(input);
    expect(state.cookies).toEqual([ADULT_COOKIE]);
    expect(input.cookies[0]?.value).toBe("f");
  });
});

describe("loading the saved session", () => {
  it("returns an anonymous state with only adult=t when no session file exists", async () => {
    const loaded = await loadSessionState(join(await createTempDirectory(), "missing.json"));
    expect(loaded.hasSession).toBe(false);
    expect(loaded.state.cookies).toEqual([ADULT_COOKIE]);
  });

  it("loads a saved session, keeps BOOTH cookies, drops others, and adds adult=t", async () => {
    const sessionFile = join(await createTempDirectory(), "session.json");
    const saved: StorageState = { cookies: [cookie("_plaza_session_test", ".booth.pm"), cookie("x", ".example.com")], origins: [] };
    await writeFile(sessionFile, JSON.stringify(saved), "utf8");
    const loaded = await loadSessionState(sessionFile);
    expect(loaded.hasSession).toBe(true);
    expect(loaded.state.cookies.map((entry) => entry.name)).toEqual(["_plaza_session_test", "adult"]);
  });

  it("treats a corrupt session file as AUTH_REQUIRED", async () => {
    const sessionFile = join(await createTempDirectory(), "session.json");
    await writeFile(sessionFile, "{not json", "utf8");
    await expect(loadSessionState(sessionFile)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(loadSessionState(sessionFile)).rejects.toBeInstanceOf(BoothError);
  });
});

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "avatar-closet-mcp-session-"));
  tempPaths.push(directory);
  return directory;
}

function cookie(name: string, domain: string): StorageCookie {
  return { name, value: "fictional-value", domain, path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" };
}
