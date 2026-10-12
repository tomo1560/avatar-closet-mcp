import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOWNLOAD_HOSTS,
  DEFAULT_HEADERS_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  getDownloadConfig,
  isAllowedDownloadHost,
} from "../src/booth/download.js";

const ABS_DIR = join(tmpdir(), "avatar-closet-mcp-config-test");

describe("getDownloadConfig gating", () => {
  it("is disabled with defaults when nothing is set", () => {
    expect(getDownloadConfig({})).toEqual({
      enabled: false,
      destDir: null,
      allowedHosts: DEFAULT_DOWNLOAD_HOSTS,
      maxBytes: DEFAULT_MAX_BYTES,
      headersTimeoutMs: DEFAULT_HEADERS_TIMEOUT_MS,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      issues: [],
    });
    expect(DEFAULT_MAX_BYTES).toBe(4 * 1024 ** 3);
    expect([DEFAULT_HEADERS_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS]).toEqual([30_000, 60_000]);
  });

  it.each([
    ["flag unset", { BOOTH_MCP_DOWNLOAD_DIR: ABS_DIR }],
    ["flag 0", { BOOTH_MCP_ENABLE_DOWNLOAD: "0", BOOTH_MCP_DOWNLOAD_DIR: ABS_DIR }],
    ["flag true", { BOOTH_MCP_ENABLE_DOWNLOAD: "true", BOOTH_MCP_DOWNLOAD_DIR: ABS_DIR }],
    ["flag 1 without dir", { BOOTH_MCP_ENABLE_DOWNLOAD: "1" }],
    ["flag 1 with empty dir", { BOOTH_MCP_ENABLE_DOWNLOAD: "1", BOOTH_MCP_DOWNLOAD_DIR: "  " }],
    ["flag 1 with relative dir", { BOOTH_MCP_ENABLE_DOWNLOAD: "1", BOOTH_MCP_DOWNLOAD_DIR: "downloads" }],
    ["flag 1 with dot-relative dir", { BOOTH_MCP_ENABLE_DOWNLOAD: "1", BOOTH_MCP_DOWNLOAD_DIR: "./downloads" }],
  ])("is disabled: %s", (_label, env) => {
    expect(getDownloadConfig(env).enabled).toBe(false);
  });

  it("is enabled only with flag 1 and an absolute directory", () => {
    const config = getDownloadConfig({ BOOTH_MCP_ENABLE_DOWNLOAD: "1", BOOTH_MCP_DOWNLOAD_DIR: `${ABS_DIR}/` });
    expect(config).toMatchObject({ enabled: true, destDir: resolve(ABS_DIR), maxBytes: DEFAULT_MAX_BYTES, issues: [] });
    expect(config.allowedHosts).toEqual(DEFAULT_DOWNLOAD_HOSTS);
  });

  it("reports why an opted-in config is disabled", () => {
    expect(getDownloadConfig({ BOOTH_MCP_ENABLE_DOWNLOAD: "1" }).issues).toEqual([
      expect.stringContaining("BOOTH_MCP_DOWNLOAD_DIR"),
    ]);
    const relative = getDownloadConfig({ BOOTH_MCP_ENABLE_DOWNLOAD: "1", BOOTH_MCP_DOWNLOAD_DIR: "rel" });
    expect(relative.destDir).toBeNull();
    expect(relative.issues).toEqual([expect.stringContaining("絶対パス")]);
  });

  it("parses BOOTH_MCP_DOWNLOAD_HOSTS case-insensitively and ignores blank entries", () => {
    const config = getDownloadConfig({ BOOTH_MCP_DOWNLOAD_HOSTS: " s6.booth.pm, *.Example.COM ,," });
    expect(config.allowedHosts).toEqual(["s6.booth.pm", "*.example.com"]);
  });

  it("falls back to the default allowlist when the host list is blank", () => {
    expect(getDownloadConfig({ BOOTH_MCP_DOWNLOAD_HOSTS: " , " }).allowedHosts).toEqual(DEFAULT_DOWNLOAD_HOSTS);
  });

  it.each(["*", "*.pm", "https://s6.booth.pm", "s6.booth.pm/path", "s6.booth.pm:443", "booth", "s6.booth.pm."])(
    "fails closed on an invalid host entry %s",
    (entry) => {
      const config = getDownloadConfig({
        BOOTH_MCP_ENABLE_DOWNLOAD: "1",
        BOOTH_MCP_DOWNLOAD_DIR: ABS_DIR,
        BOOTH_MCP_DOWNLOAD_HOSTS: `s6.booth.pm,${entry}`,
      });
      expect(config.enabled).toBe(false);
      expect(config.issues).toEqual([expect.stringContaining("BOOTH_MCP_DOWNLOAD_HOSTS")]);
    },
  );

  it("parses BOOTH_MCP_DOWNLOAD_MAX_BYTES", () => {
    const env = { BOOTH_MCP_ENABLE_DOWNLOAD: "1", BOOTH_MCP_DOWNLOAD_DIR: ABS_DIR, BOOTH_MCP_DOWNLOAD_MAX_BYTES: "1048576" };
    expect(getDownloadConfig(env)).toMatchObject({ enabled: true, maxBytes: 1_048_576 });
  });

  it("treats BOOTH_MCP_DOWNLOAD_MAX_BYTES=0 as unlimited", () => {
    const env = { BOOTH_MCP_ENABLE_DOWNLOAD: "1", BOOTH_MCP_DOWNLOAD_DIR: ABS_DIR, BOOTH_MCP_DOWNLOAD_MAX_BYTES: " 0 " };
    expect(getDownloadConfig(env)).toMatchObject({ enabled: true, maxBytes: null, issues: [] });
  });

  it("applies BOOTH_MCP_DOWNLOAD_TIMEOUT_SEC to both the header wait and the idle gap", () => {
    const env = { BOOTH_MCP_ENABLE_DOWNLOAD: "1", BOOTH_MCP_DOWNLOAD_DIR: ABS_DIR, BOOTH_MCP_DOWNLOAD_TIMEOUT_SEC: "120" };
    expect(getDownloadConfig(env)).toMatchObject({ enabled: true, headersTimeoutMs: 120_000, idleTimeoutMs: 120_000 });
  });

  it.each(["0", "-1", "abc", "1.5", "86401"])("fails closed on timeout %s", (value) => {
    const config = getDownloadConfig({
      BOOTH_MCP_ENABLE_DOWNLOAD: "1",
      BOOTH_MCP_DOWNLOAD_DIR: ABS_DIR,
      BOOTH_MCP_DOWNLOAD_TIMEOUT_SEC: value,
    });
    expect(config.enabled).toBe(false);
    expect(config.issues).toEqual([expect.stringContaining("BOOTH_MCP_DOWNLOAD_TIMEOUT_SEC")]);
  });

  it.each(["-1", "abc", "1.5", "1e9", "99999999999999999999"])("fails closed on max bytes %s", (value) => {
    const config = getDownloadConfig({
      BOOTH_MCP_ENABLE_DOWNLOAD: "1",
      BOOTH_MCP_DOWNLOAD_DIR: ABS_DIR,
      BOOTH_MCP_DOWNLOAD_MAX_BYTES: value,
    });
    expect(config.enabled).toBe(false);
    expect(config.maxBytes).toBeNull();
    expect(config.issues).toEqual([expect.stringContaining("BOOTH_MCP_DOWNLOAD_MAX_BYTES")]);
  });

  it("returns frozen data", () => {
    const config = getDownloadConfig({});
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.allowedHosts)).toBe(true);
  });
});

describe("isAllowedDownloadHost", () => {
  const hosts = ["*.booth.pm", "cdn.example.net"];

  it.each(["s6.booth.pm", "S6.BOOTH.PM", "download.booth.pm", "a.b.booth.pm", "cdn.example.net", "CDN.example.net"])(
    "allows %s",
    (host) => {
      expect(isAllowedDownloadHost(host, hosts)).toBe(true);
    },
  );

  it.each([
    "booth.pm",
    "evilbooth.pm",
    "s6.booth.pm.evil.example",
    "s6.booth.pm.",
    "x.cdn.example.net",
    "example.net",
    "",
    "[::1]",
    "s6.booth.pm:8443",
    "user@s6.booth.pm",
  ])("refuses %s", (host) => {
    expect(isAllowedDownloadHost(host, hosts)).toBe(false);
  });

  it("refuses everything with an empty allowlist", () => {
    expect(isAllowedDownloadHost("s6.booth.pm", [])).toBe(false);
  });

  it("allows only *.booth.pm by default", () => {
    expect(DEFAULT_DOWNLOAD_HOSTS).toEqual(["*.booth.pm"]);
    expect(isAllowedDownloadHost("s6.booth.pm", DEFAULT_DOWNLOAD_HOSTS)).toBe(true);
    expect(isAllowedDownloadHost("booth.pximg.net", DEFAULT_DOWNLOAD_HOSTS)).toBe(false);
  });
});
