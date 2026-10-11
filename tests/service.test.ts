import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoothReader } from "../src/browser/reader.js";
import { BoothError } from "../src/errors.js";
import { BoothService } from "../src/service.js";

const tempPaths: string[] = [];
const settingsHtml = await readFile(fileURLToPath(new URL("./fixtures/account-settings.html", import.meta.url)), "utf8");

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

type FakePage = { html: string; url: string } | BoothError;

class FakeReader implements BoothReader {
  readonly paths: string[] = [];
  closed = 0;

  constructor(private readonly page: FakePage) {}

  read<T>(path: string, parser: (html: string, finalUrl: string) => T): Promise<{ data: T; url: string }> {
    this.paths.push(path);
    if (this.page instanceof BoothError) return Promise.reject(this.page);
    return Promise.resolve({ data: parser(this.page.html, this.page.url), url: this.page.url });
  }

  readJson<T>(): Promise<{ data: T; url: string }> {
    return Promise.reject(new Error("not used"));
  }

  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }
}

describe("authStatus", () => {
  it("reports logged in with the display name when /settings stays on accounts.booth.pm", async () => {
    const reader = new FakeReader({ html: settingsHtml, url: "https://accounts.booth.pm/settings" });
    const result = await new BoothService(reader).authStatus();
    expect(reader.paths).toEqual(["https://accounts.booth.pm/settings"]);
    expect(result.data).toEqual({ authenticated: true, displayName: "Fictional Buyer" });
    expect(result.meta.sourceUrl).toBe("https://accounts.booth.pm/settings");
  });

  it("reports logged out on AUTH_REQUIRED (no session or redirect to sign-in)", async () => {
    const reader = new FakeReader(new BoothError("AUTH_REQUIRED", "login required"));
    await expect(new BoothService(reader).authStatus()).resolves.toMatchObject({ data: { authenticated: false } });
  });

  it("reports logged out when the final URL is not the settings page", async () => {
    const reader = new FakeReader({ html: settingsHtml, url: "https://accounts.booth.pm/" });
    await expect(new BoothService(reader).authStatus()).resolves.toMatchObject({ data: { authenticated: false } });
  });

  it("propagates other failures", async () => {
    const reader = new FakeReader(new BoothError("RATE_LIMITED", "slow down"));
    await expect(new BoothService(reader).authStatus()).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("login", () => {
  it("runs the interactive login with the requested timeout and resets the HTTP session", async () => {
    const reader = new FakeReader(new BoothError("AUTH_REQUIRED", "x"));
    const login = vi.fn(() => Promise.resolve());
    const result = await new BoothService(reader, { login }).login({ timeoutSec: 120 });
    expect(login).toHaveBeenCalledWith(120_000);
    expect(reader.closed).toBe(1);
    expect(result.data).toEqual({ authenticated: true });
  });

  it("defaults to a 10 minute timeout", async () => {
    const login = vi.fn(() => Promise.resolve());
    await new BoothService(new FakeReader(new BoothError("AUTH_REQUIRED", "x")), { login }).login();
    expect(login).toHaveBeenCalledWith(600_000);
  });

  it.each([0, 5, 1_801, 1.5])("rejects timeoutSec=%s without opening a browser", async (timeoutSec) => {
    const login = vi.fn(() => Promise.resolve());
    const service = new BoothService(new FakeReader(new BoothError("AUTH_REQUIRED", "x")), { login });
    await expect(service.login({ timeoutSec })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(login).not.toHaveBeenCalled();
  });
});

describe("logout", () => {
  it("closes the HTTP session and deletes session.json and the default profile", async () => {
    const appDir = await mkdtemp(join(tmpdir(), "booth-library-mcp-service-"));
    tempPaths.push(appDir);
    await writeFile(join(appDir, "session.json"), "{}", "utf8");
    await mkdir(join(appDir, "browser-profile", "Default"), { recursive: true });
    // Written by login; logout only deletes a profile that carries it.
    await writeFile(join(appDir, "browser-profile", "booth-library-mcp-profile.json"), "{}", "utf8");
    const reader = new FakeReader(new BoothError("AUTH_REQUIRED", "x"));

    const result = await new BoothService(reader, { env: { BOOTH_MCP_HOME: appDir } }).logout();

    expect(reader.closed).toBe(1);
    expect(result.data).toEqual({ sessionFileRemoved: true, profileDirRemoved: true, warnings: [] });
    await expect(stat(join(appDir, "session.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(appDir, "browser-profile"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
