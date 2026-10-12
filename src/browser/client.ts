import { chromium, type BrowserContext, type Page } from "playwright-core";
import { BoothError } from "../errors.js";
import { getProfileDir, getSessionFile } from "../profile.js";
import { persistBoothSession } from "../session-state.js";
import { prepareProfileDir } from "./profile-dir.js";
import { ACCOUNT_SETTINGS_URL, isSignInUrl } from "./url-policy.js";
import { isBoothHost } from "./read-only-guard.js";

export const LOGIN_START_URL = ACCOUNT_SETTINGS_URL;
export const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 1_000;
const REOPEN_INTERVAL_MS = 15_000;

export type LoginPageState = "logged_in" | "signing_in" | "booth" | "other";

export interface ReopenTracker {
  sawSignIn: boolean;
  lastReopenAt: number | undefined;
}

export type LoginBrowserCandidate =
  | { label: string; executablePath: string }
  | { label: string; channel: "chrome" | "msedge" };

export function getLoginBrowserCandidates(env: NodeJS.ProcessEnv = process.env): LoginBrowserCandidate[] {
  const candidates: LoginBrowserCandidate[] = [];
  if (env.BOOTH_MCP_BROWSER_PATH) {
    candidates.push({ label: "BOOTH_MCP_BROWSER_PATH", executablePath: env.BOOTH_MCP_BROWSER_PATH });
  }
  candidates.push({ label: "Google Chrome", channel: "chrome" });
  candidates.push({ label: "Microsoft Edge", channel: "msedge" });
  return candidates;
}

/**
 * Logged in = a page sits on accounts.booth.pm and is not a sign-in page. Sign-in pages on BOOTH
 * and any pixiv page (OAuth) mean the user is still signing in.
 * TODO(PLAN §7): verify against the real post-OAuth redirect chain.
 */
export function classifyLoginUrl(value: string): LoginPageState {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "other";
  }
  if (isSignInUrl(url)) return "signing_in";
  if (url.protocol !== "https:" || !isBoothHost(url.hostname)) return "other";
  return url.hostname === "accounts.booth.pm" ? "logged_in" : "booth";
}

/**
 * After pixiv OAuth, BOOTH may land on booth.pm instead of accounts.booth.pm. Once the sign-in flow
 * has been seen and no page is still in it, reopen the settings page (throttled to every 15s).
 */
export function shouldReopenSettings(states: readonly LoginPageState[], tracker: ReopenTracker, nowMs: number): boolean {
  if (!tracker.sawSignIn || states.includes("signing_in") || !states.includes("booth")) return false;
  return tracker.lastReopenAt === undefined || nowMs - tracker.lastReopenAt >= REOPEN_INTERVAL_MS;
}

/**
 * Opens Chrome/Edge with a dedicated persistent profile at the buyer settings page and waits for the
 * user to sign in manually (pixiv OAuth; credentials are never automated or read). On success the
 * BOOTH-only cookies (plus adult=t) are saved to session.json.
 */
export async function runInteractiveLogin(
  timeoutMs = DEFAULT_LOGIN_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const profileDir = getProfileDir(env);
  await prepareProfileDir(profileDir);
  const context = await launchLoginBrowser(profileDir, env);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(LOGIN_START_URL, { waitUntil: "domcontentloaded" });
    if (!hasLoggedInPage(context)) {
      process.stderr.write(
        "ブラウザで BOOTH（pixiv アカウント）へのログインを完了してください。ID・パスワードを avatar-closet-mcp が読み取ることはありません。\n",
      );
      await waitForLogin(context, timeoutMs);
    }
    await persistBoothSession(context, getSessionFile(env));
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function waitForLogin(context: BrowserContext, timeoutMs: number): Promise<void> {
  let closed = false;
  context.once("close", () => {
    closed = true;
  });
  const tracker: ReopenTracker = { sawSignIn: false, lastReopenAt: undefined };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (closed) throw new BoothError("AUTH_REQUIRED", "ログインが完了する前にブラウザが閉じられました。");
    if (hasLoggedInPage(context)) return;
    await reopenSettingsIfReturned(context.pages(), tracker);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new BoothError("AUTH_REQUIRED", `${Math.round(timeoutMs / 1_000)} 秒以内にログインが完了しませんでした。`);
}

function hasLoggedInPage(context: BrowserContext): boolean {
  return context.pages().some((page) => classifyLoginUrl(page.url()) === "logged_in");
}

async function reopenSettingsIfReturned(pages: Page[], tracker: ReopenTracker): Promise<void> {
  const states = pages.map((page) => classifyLoginUrl(page.url()));
  if (states.includes("signing_in")) tracker.sawSignIn = true;
  const now = Date.now();
  if (!shouldReopenSettings(states, tracker, now)) return;
  tracker.lastReopenAt = now;
  const target = pages[states.indexOf("booth")];
  await target?.goto(LOGIN_START_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined);
}

/**
 * Tries each candidate browser in turn. The launch errors themselves are not reported: they name
 * executable and profile paths (which contain the OS user name).
 */
async function launchLoginBrowser(profileDir: string, env: NodeJS.ProcessEnv): Promise<BrowserContext> {
  const tried: string[] = [];
  for (const candidate of getLoginBrowserCandidates(env)) {
    try {
      return await chromium.launchPersistentContext(profileDir, {
        headless: false,
        locale: "ja-JP",
        ...("executablePath" in candidate ? { executablePath: candidate.executablePath } : { channel: candidate.channel }),
      });
    } catch {
      tried.push(candidate.label);
    }
  }
  throw new BoothError(
    "INTERNAL_ERROR",
    `ログイン用の Chrome / Edge を起動できませんでした（試行: ${tried.join(", ")}）。どちらかをインストールするか、BOOTH_MCP_BROWSER_PATH に Chromium 系ブラウザの実行ファイルを指定してください。`,
  );
}
