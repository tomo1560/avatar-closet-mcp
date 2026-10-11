import { join } from "node:path";
import type { SearchUrlParams } from "./booth/public.js";
import { DEFAULT_LOGIN_TIMEOUT_MS, runInteractiveLogin } from "./browser/client.js";
import { BoothHttpClient } from "./browser/http-client.js";
import { clearLocalLogin, getLocalLoginPaths } from "./browser/logout.js";
import type { BoothReader } from "./browser/reader.js";
import { ACCOUNT_SETTINGS_URL, ACCOUNTS_ORIGIN } from "./browser/url-policy.js";
import { ItemCache } from "./cache/item-cache.js";
import { UnavailableItems } from "./cache/unavailable-items.js";
import { BoothError } from "./errors.js";
import { parseAccountSettings } from "./parsers/account.js";
import { getAvatarDictionaryFile, getCacheDir, getSessionFile } from "./profile.js";
import { initAvatarDictionary, listMyAvatars, searchForAvatar, type AvatarSearchInput } from "./services/avatars.js";
import { Memo, OWNED_ITEMS_TTL_MS, type ServiceContext } from "./services/context.js";
import { checkItemCompatibility, getItemDetail, searchItems, suggestTagNames, type CompatibilityInput, type GetItemInput } from "./services/items.js";
import { listLibrary, type LibraryQuery } from "./services/library.js";
import { getOrder, listOrders } from "./services/orders.js";
import { wrap } from "./services/result.js";
import { syncAllMetadata, syncLibraryMetadata, type SyncAllOptions } from "./services/sync.js";
import type {
  AuthStatus,
  AvatarInitResult,
  AvatarSearchResult,
  BoothResult,
  CompatibilityReport,
  ItemDetail,
  LibraryListing,
  LoginResult,
  LogoutResult,
  MyAvatarsResult,
  OrderResult,
  OrdersListing,
  SearchResult,
  SyncResult,
  TagSuggestions,
} from "./types.js";

export { assertNumericId, normalizeLimit, normalizePage, wrap } from "./services/result.js";
export type { AvatarSearchInput } from "./services/avatars.js";
export type { CompatibilityInput, GetItemInput } from "./services/items.js";
export type { LibraryQuery } from "./services/library.js";
export type { SyncAllOptions, SyncProgress } from "./services/sync.js";

export const MIN_LOGIN_TIMEOUT_SEC = 30;
export const MAX_LOGIN_TIMEOUT_SEC = 1_800;

export interface BoothServiceOptions {
  /** Interactive browser login. Injectable for tests. */
  login?: (timeoutMs: number) => Promise<void>;
  /** Environment used to locate session.json, the browser profile, the cache and avatars.json. */
  env?: NodeJS.ProcessEnv;
  /** Item metadata cache. Defaults to `{cache dir}/items`. */
  cache?: ItemCache;
}

/** Single place of business logic shared by the MCP server and the CLI. */
export class BoothService {
  private readonly browser: BoothReader;
  private readonly runLogin: (timeoutMs: number) => Promise<void>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly ctx: ServiceContext;

  constructor(browser?: BoothReader, options: BoothServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.browser = browser ?? new BoothHttpClient({ sessionFile: getSessionFile(this.env) });
    this.runLogin = options.login ?? ((timeoutMs: number): Promise<void> => runInteractiveLogin(timeoutMs, this.env));
    const cacheDir = getCacheDir(this.env);
    this.ctx = {
      reader: this.browser,
      cache: options.cache ?? new ItemCache({ dir: join(cacheDir, "items") }),
      unavailable: new UnavailableItems({ file: join(cacheDir, "unavailable-items.json") }),
      avatarsFile: getAvatarDictionaryFile(this.env),
      ownedItems: new Memo(OWNED_ITEMS_TTL_MS),
    };
  }

  /** avatars.json used by this service (for CLI messages; never returned by MCP tools). */
  get avatarsFile(): string {
    return this.ctx.avatarsFile;
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
    this.ctx.ownedItems.clear();
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
    this.ctx.ownedItems.clear();
    return wrap(await clearLocalLogin(getLocalLoginPaths(this.env)), `${ACCOUNTS_ORIGIN}/`);
  }

  getItem(input: GetItemInput): Promise<BoothResult<ItemDetail>> {
    return getItemDetail(this.ctx, input);
  }

  searchItems(params: SearchUrlParams): Promise<BoothResult<SearchResult>> {
    return searchItems(this.ctx, params);
  }

  suggestTags(term: string): Promise<BoothResult<TagSuggestions>> {
    return suggestTagNames(this.ctx, term);
  }

  listLibrary(query: LibraryQuery = {}): Promise<BoothResult<LibraryListing>> {
    return listLibrary(this.ctx, "library", query);
  }

  listGifts(query: LibraryQuery = {}): Promise<BoothResult<LibraryListing>> {
    return listLibrary(this.ctx, "gifts", query);
  }

  listOrders(page?: number): Promise<BoothResult<OrdersListing>> {
    return listOrders(this.ctx, page);
  }

  getOrder(orderId: string): Promise<BoothResult<OrderResult>> {
    return getOrder(this.ctx, orderId);
  }

  checkCompatibility(input: CompatibilityInput): Promise<BoothResult<CompatibilityReport>> {
    return checkItemCompatibility(this.ctx, input);
  }

  listMyAvatars(): Promise<BoothResult<MyAvatarsResult>> {
    return listMyAvatars(this.ctx);
  }

  searchForAvatar(input: AvatarSearchInput): Promise<BoothResult<AvatarSearchResult>> {
    return searchForAvatar(this.ctx, input);
  }

  syncLibraryMetadata(maxItems?: number): Promise<BoothResult<SyncResult>> {
    return syncLibraryMetadata(this.ctx, maxItems);
  }

  /** CLI `sync`: walk the library once, then fetch in batches until done (bounded). */
  syncAllMetadata(options: SyncAllOptions = {}): Promise<BoothResult<SyncResult>> {
    return syncAllMetadata(this.ctx, options);
  }

  /** CLI `avatars init`: add owned avatar bodies missing from the dictionary to avatars.json. */
  initAvatarDictionary(): Promise<BoothResult<AvatarInitResult>> {
    return initAvatarDictionary(this.ctx);
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
