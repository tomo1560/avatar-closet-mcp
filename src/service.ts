import { DEFAULT_LOGIN_TIMEOUT_MS, runInteractiveLogin } from "./browser/client.js";
import { BoothHttpClient } from "./browser/http-client.js";
import { clearLocalLogin, getLocalLoginPaths } from "./browser/logout.js";
import type { BoothReader } from "./browser/reader.js";
import { ACCOUNT_SETTINGS_URL, ACCOUNTS_ORIGIN } from "./browser/url-policy.js";
import { BoothError } from "./errors.js";
import { parseAccountSettings } from "./parsers/account.js";
import { getSessionFile } from "./profile.js";
import type { AuthStatus, BoothResult, LoginResult, LogoutResult } from "./types.js";

export const MIN_LOGIN_TIMEOUT_SEC = 30;
export const MAX_LOGIN_TIMEOUT_SEC = 1_800;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export interface BoothServiceOptions {
  /** Interactive browser login. Injectable for tests. */
  login?: (timeoutMs: number) => Promise<void>;
  /** Environment used to locate session.json and the browser profile. */
  env?: NodeJS.ProcessEnv;
}

/** Single place of business logic shared by the MCP server and the CLI. */
export class BoothService {
  private readonly browser: BoothReader;
  private readonly runLogin: (timeoutMs: number) => Promise<void>;
  private readonly env: NodeJS.ProcessEnv;

  constructor(browser?: BoothReader, options: BoothServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.browser = browser ?? new BoothHttpClient({ sessionFile: getSessionFile(this.env) });
    this.runLogin = options.login ?? ((timeoutMs: number): Promise<void> => runInteractiveLogin(timeoutMs, this.env));
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  /** Opens Chrome/Edge for a manual pixiv sign-in, then resets the HTTP session so it reloads cookies. */
  async login(input: { timeoutSec?: number | undefined } = {}): Promise<BoothResult<LoginResult>> {
    const timeoutSec = input.timeoutSec ?? DEFAULT_LOGIN_TIMEOUT_MS / 1_000;
    if (!Number.isInteger(timeoutSec) || timeoutSec < MIN_LOGIN_TIMEOUT_SEC || timeoutSec > MAX_LOGIN_TIMEOUT_SEC) {
      throw new BoothError(
        "INVALID_INPUT",
        `timeout_sec は ${MIN_LOGIN_TIMEOUT_SEC}〜${MAX_LOGIN_TIMEOUT_SEC} の整数で指定してください。`,
      );
    }
    await this.runLogin(timeoutSec * 1_000);
    await this.browser.close();
    return wrap({ authenticated: true }, ACCOUNT_SETTINGS_URL);
  }

  /** Logged in iff GET accounts.booth.pm/settings ends on that page (no sign-in redirect). */
  async authStatus(): Promise<BoothResult<AuthStatus>> {
    try {
      const result = await this.browser.read(ACCOUNT_SETTINGS_URL, parseAccountSettings);
      if (!isAccountSettingsUrl(result.url)) return wrap({ authenticated: false }, result.url);
      return wrap({ authenticated: true, ...result.data }, result.url);
    } catch (error) {
      if (error instanceof BoothError && error.code === "AUTH_REQUIRED") {
        return wrap({ authenticated: false }, ACCOUNT_SETTINGS_URL);
      }
      throw error;
    }
  }

  /** Deletes session.json and the login browser profile. Local only; BOOTH is not contacted. */
  async logout(): Promise<BoothResult<LogoutResult>> {
    await this.browser.close();
    return wrap(await clearLocalLogin(getLocalLoginPaths(this.env)), `${ACCOUNTS_ORIGIN}/`);
  }
}

function isAccountSettingsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "accounts.booth.pm" && /^\/settings\/?$/u.test(url.pathname);
  } catch {
    return false;
  }
}

/** Shared envelope for every tool result. */
export function wrap<T>(
  data: T,
  sourceUrl: string,
  extra: { page?: number; nextPage?: number; redactions?: string[] } = {},
): BoothResult<T> {
  return {
    data,
    meta: {
      fetchedAt: new Date().toISOString(),
      sourceUrl,
      redactions: extra.redactions ?? [],
      ...(extra.page !== undefined ? { page: extra.page } : {}),
      ...(extra.nextPage !== undefined ? { nextPage: extra.nextPage } : {}),
    },
  };
}

/** Helpers kept for the paged buyer tools (library, gifts, orders). */
export function normalizePage(page: number | undefined): number {
  return page && Number.isInteger(page) && page > 0 ? page : 1;
}

export function normalizeLimit(limit: number | undefined): number {
  if (!limit || !Number.isInteger(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

export function assertNumericId(id: string, label: string): void {
  if (!/^\d{1,20}$/u.test(id)) throw new BoothError("INVALID_INPUT", `${label} ID は数字で指定してください。`);
}
