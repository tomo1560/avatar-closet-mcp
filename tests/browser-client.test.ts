import { describe, expect, it } from "vitest";
import {
  classifyLoginUrl,
  getLoginBrowserCandidates,
  LOGIN_START_URL,
  shouldReopenSettings,
} from "../src/browser/client.js";

describe("login browser selection", () => {
  it("uses installed Chrome and Edge channels without a bundled browser", () => {
    expect(getLoginBrowserCandidates({})).toEqual([
      { label: "Google Chrome", channel: "chrome" },
      { label: "Microsoft Edge", channel: "msedge" },
    ]);
  });

  it("prefers an explicitly configured Chromium executable", () => {
    expect(getLoginBrowserCandidates({ BOOTH_MCP_BROWSER_PATH: "/opt/browser/chrome" })[0]).toEqual({
      label: "BOOTH_MCP_BROWSER_PATH",
      executablePath: "/opt/browser/chrome",
    });
  });
});

describe("buyer login detection", () => {
  it("starts on the buyer account settings page", () => {
    expect(LOGIN_START_URL).toBe("https://accounts.booth.pm/settings");
  });

  it.each([
    ["https://accounts.booth.pm/settings", "logged_in"],
    ["https://accounts.booth.pm/library", "logged_in"],
    ["https://booth.pm/users/sign_in", "signing_in"],
    ["https://booth.pm/ja/users/sign_in?return_to=x", "signing_in"],
    ["https://accounts.booth.pm/users/sign_in", "signing_in"],
    ["https://accounts.pixiv.net/login?return_to=x", "signing_in"],
    ["https://oauth.secure.pixiv.net/v2/auth", "signing_in"],
    ["https://booth.pm/ja", "booth"],
    ["https://sample-shop.booth.pm/", "booth"],
    ["about:blank", "other"],
    ["https://example.com/", "other"],
  ] as const)("classifies %s as %s", (url, expected) => {
    expect(classifyLoginUrl(url)).toBe(expected);
  });

  it("reopens the settings page only after the sign-in flow returned to booth.pm, at most every 15s", () => {
    expect(shouldReopenSettings(["booth"], { sawSignIn: false, lastReopenAt: undefined }, 100_000)).toBe(false);
    expect(shouldReopenSettings(["booth"], { sawSignIn: true, lastReopenAt: undefined }, 100_000)).toBe(true);
    expect(shouldReopenSettings(["booth"], { sawSignIn: true, lastReopenAt: 90_000 }, 100_000)).toBe(false);
    expect(shouldReopenSettings(["booth"], { sawSignIn: true, lastReopenAt: 80_000 }, 100_000)).toBe(true);
    expect(shouldReopenSettings(["signing_in", "booth"], { sawSignIn: true, lastReopenAt: undefined }, 100_000)).toBe(false);
  });
});
