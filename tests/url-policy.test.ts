import { describe, expect, it } from "vitest";
import { BoothError } from "../src/errors.js";
import {
  ACCOUNTS_ORIGIN,
  BOOTH_ORIGIN,
  isDownloadableUrl,
  isSignInUrl,
  requiresSession,
  resolveBoothUrl,
} from "../src/browser/url-policy.js";
import { backoffDelayMs, isRetryableStatus, MAX_RETRIES } from "../src/browser/retry.js";

describe("BOOTH URL policy", () => {
  it("resolves relative paths against booth.pm by default", () => {
    expect(resolveBoothUrl("/ja/items/123.json").toString()).toBe("https://booth.pm/ja/items/123.json");
  });

  it("resolves relative paths against an allowed explicit origin", () => {
    expect(resolveBoothUrl("/library?page=2", ACCOUNTS_ORIGIN).toString()).toBe("https://accounts.booth.pm/library?page=2");
  });

  it.each([
    "https://booth.pm/ja/items/123.json",
    "https://accounts.booth.pm/library?page=2",
    "https://booth.pm/ja/search/%E8%A1%A3%E8%A3%85?page=1",
    "HTTPS://BOOTH.PM/autocomplete/tag.json?term=x",
    "https://booth.pm:443/ja/items/1.json",
  ])("allows %s", (url) => {
    expect(() => resolveBoothUrl(url)).not.toThrow();
  });

  it.each([
    "https://example.com/",
    "https://booth.pm.example.com/",
    "https://sample-shop.booth.pm/items/1",
    "https://manage.booth.pm/orders",
    "https://api.booth.pm/frontend/manage/orders/1.json",
    "http://booth.pm/ja/items/1.json",
    "https://booth.pm:8443/ja/items/1.json",
    "https://user:pass@booth.pm/",
    "//example.com/path",
    "file:///etc/passwd",
  ])("rejects %s before any request", (url) => {
    expect(() => resolveBoothUrl(url)).toThrow(BoothError);
    try {
      resolveBoothUrl(url);
    } catch (error) {
      expect((error as BoothError).code).toBe("INVALID_INPUT");
    }
  });

  it("rejects a default origin that is not allowed", () => {
    expect(() => resolveBoothUrl("/x", "https://example.com")).toThrow(BoothError);
  });

  it("requires a session for accounts pages and downloadables only", () => {
    expect(requiresSession(new URL("https://accounts.booth.pm/settings"))).toBe(true);
    expect(requiresSession(new URL("https://booth.pm/downloadables/42"))).toBe(true);
    expect(requiresSession(new URL("https://booth.pm/ja/items/1.json"))).toBe(false);
    expect(requiresSession(new URL("https://booth.pm/autocomplete/tag.json?term=a"))).toBe(false);
  });

  it.each([
    ["https://booth.pm/users/sign_in", true],
    ["https://booth.pm/ja/users/sign_in?return_to=x", true],
    ["https://accounts.booth.pm/users/sign_in", true],
    ["https://booth.pm/users/auth/pixiv", true],
    ["https://accounts.pixiv.net/login?return_to=x", true],
    ["https://www.pixiv.net/", true],
    ["https://accounts.booth.pm/settings", false],
    ["https://booth.pm/ja", false],
    ["https://booth.pm/ja/items/1", false],
    ["https://booth.pm/ja/search/login", false],
    ["not a url", false],
  ] as const)("classifies %s as sign-in=%s", (url, expected) => {
    expect(isSignInUrl(url)).toBe(expected);
  });

  it.each([
    ["https://booth.pm/downloadables/42", true],
    ["https://booth.pm/downloadables/42?variation_id=7", true],
    ["https://booth.pm/downloadables/abc", false],
    ["https://booth.pm/downloadables/42/extra", false],
    ["https://booth.pm/downloadables/42?variation_id=7&x=1", false],
    ["https://booth.pm/downloadables/42?other=1", false],
    ["https://accounts.booth.pm/downloadables/42", false],
    ["https://booth.pm/ja/items/42.json", false],
  ] as const)("classifies %s as downloadable=%s", (url, expected) => {
    expect(isDownloadableUrl(new URL(url))).toBe(expected);
  });

  it("exposes the two allowed origins", () => {
    expect([BOOTH_ORIGIN, ACCOUNTS_ORIGIN]).toEqual(["https://booth.pm", "https://accounts.booth.pm"]);
  });
});

describe("retry backoff", () => {
  it("retries only 429 and 503", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(500)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(MAX_RETRIES).toBe(3);
  });

  it("uses exponential delays of 2s, 4s and 8s", () => {
    expect([0, 1, 2].map((retry) => backoffDelayMs(retry, undefined, 0))).toEqual([2_000, 4_000, 8_000]);
  });

  it("honours Retry-After seconds when longer than the exponential delay", () => {
    expect(backoffDelayMs(0, "5", 0)).toBe(5_000);
    expect(backoffDelayMs(2, "1", 0)).toBe(8_000);
  });

  it("caps Retry-After at 30 seconds", () => {
    expect(backoffDelayMs(0, "120", 0)).toBe(30_000);
  });

  it("accepts an HTTP-date Retry-After and ignores garbage", () => {
    const now = Date.parse("2026-10-12T00:00:00Z");
    expect(backoffDelayMs(0, "Mon, 12 Oct 2026 00:00:10 GMT", now)).toBe(10_000);
    expect(backoffDelayMs(0, "soon", now)).toBe(2_000);
  });
});
