import { join } from "node:path";
import { getDownloadConfig, type DownloadConfig } from "./booth/download.js";
import type { SearchUrlParams } from "./booth/public.js";
import { DEFAULT_LOGIN_TIMEOUT_MS, runInteractiveLogin } from "./browser/client.js";
import { BoothHttpClient } from "./browser/http-client.js";
import { clearLocalLogin, getLocalLoginPaths } from "./browser/logout.js";
import type { BoothReader, BoothRedirectReader } from "./browser/reader.js";
import { ACCOUNT_SETTINGS_URL, ACCOUNTS_ORIGIN } from "./browser/url-policy.js";
import { ItemCache, resolveCacheTtl } from "./cache/item-cache.js";
import { UnavailableItems } from "./cache/unavailable-items.js";
import { BoothError } from "./errors.js";
import { getCacheSnapshotFile, getSnapshotFile } from "./library/update-snapshot.js";
import { parseAccountSettings } from "./parsers/account.js";
import { getAvatarDictionaryFile, getCacheDir, getSessionFile } from "./profile.js";
import { initAvatarDictionary, listMyAvatars, searchForAvatar, type AvatarSearchInput } from "./services/avatars.js";
import { Memo, OWNED_ITEMS_TTL_MS, type ServiceContext } from "./services/context.js";
import { downloadPurchaseFile, type DownloadPurchaseInput, type DownloadResult } from "./services/download.js";
import { checkItemCompatibility, getItemDetail, searchItems, suggestTagNames, type CompatibilityInput, type GetItemInput } from "./services/items.js";
import { listLibrary, type LibraryQuery } from "./services/library.js";
import { getOrder, listOrders } from "./services/orders.js";
import { wrap } from "./services/result.js";
import { syncAllMetadata, syncLibraryMetadata, type SyncAllOptions } from "./services/sync.js";
import { checkUnityProject, type UnityCheckResult } from "./services/unity-check.js";
import { checkUpdates, type UpdateCheckInput, type UpdateCheckResult } from "./services/updates.js";
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

export type { AvatarSearchInput } from "./services/avatars.js";
export type { DownloadPurchaseInput, DownloadResult } from "./services/download.js";
export type { CompatibilityInput, GetItemInput } from "./services/items.js";
export type { LibraryQuery } from "./services/library.js";
export type { SyncAllOptions, SyncProgress } from "./services/sync.js";
export type { UnityCheckResult } from "./services/unity-check.js";
export type { UpdateCheckInput, UpdateCheckResult } from "./services/updates.js";

export const MIN_LOGIN_TIMEOUT_SEC = 30;
export const MAX_LOGIN_TIMEOUT_SEC = 1_800;

export interface BoothServiceOptions {
  /** Interactive browser login. Injectable for tests. */
  login?: (timeoutMs: number) => Promise<void>;
  /** Environment used to locate session.json, the browser profile, the cache and avatars.json. */
  env?: NodeJS.ProcessEnv;
  /** Item metadata cache. Defaults to `{cache dir}/items`. */
  cache?: ItemCache;
  /** Reads `booth.pm/downloadables/{id}` redirects. Defaults to `browser` when it can (BoothHttpClient). */
  redirectReader?: BoothRedirectReader;
  /** fetch used for the signed download URL (no cookies). Injectable for tests. */
  downloadFetch?: typeof fetch;
  /** Receives non-fatal warnings (invalid BOOTH_MCP_CACHE_TTL_DAYS, snapshot write failures). Defaults to stderr. */
  warn?: (message: string) => void;
}

export interface DownloadOptions {
  /** CLI `--out`: absolute directory used instead of BOOTH_MCP_DOWNLOAD_DIR. */
  downloadDir?: string | undefined;
}

/** Single place of business logic shared by the MCP server and the CLI. */
export class BoothService {
  private readonly browser: BoothReader;
  private readonly runLogin: (timeoutMs: number) => Promise<void>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly ctx: ServiceContext;
  private readonly redirectReader: BoothRedirectReader | undefined;
  private readonly downloadFetch: typeof fetch | undefined;

  constructor(browser?: BoothReader, options: BoothServiceOptions = {}) {
    this.env = options.env ?? process.env;
    this.browser = browser ?? new BoothHttpClient({ sessionFile: getSessionFile(this.env) });
    this.runLogin = options.login ?? ((timeoutMs: number): Promise<void> => runInteractiveLogin(timeoutMs, this.env));
    this.redirectReader = options.redirectReader ?? (isRedirectReader(this.browser) ? this.browser : undefined);
    this.downloadFetch = options.downloadFetch;
    const cacheDir = getCacheDir(this.env);
    const warn = options.warn ?? writeWarning;
    const ttl = resolveCacheTtl(this.env);
    if (ttl.warning) warn(ttl.warning);
    this.ctx = {
      reader: this.browser,
      cache: options.cache ?? new ItemCache({ dir: join(cacheDir, "items"), ttlMs: ttl.ttlMs }),
      unavailable: new UnavailableItems({ file: join(cacheDir, "unavailable-items.json"), ttlMs: ttl.ttlMs }),
      avatarsFile: getAvatarDictionaryFile(this.env),
      ownedItems: new Memo(OWNED_ITEMS_TTL_MS),
      cacheSnapshotFile: getCacheSnapshotFile(this.env),
      updateSnapshotFile: getSnapshotFile(this.env),
      warn,
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

  /** `booth_check_updates` / CLI `updates`: download-file changes since the previous check (writes only the local baseline). */
  checkUpdates(input: UpdateCheckInput = {}): Promise<BoothResult<UpdateCheckResult>> {
    return checkUpdates(this.ctx, input);
  }

  /** CLI `unity-check`: owned items found in a Unity project (folder names and package manifests only). */
  unityCheck(projectPath: string): Promise<BoothResult<UnityCheckResult>> {
    return checkUnityProject(this.ctx, projectPath);
  }

  /** CLI `avatars init`: add owned avatar bodies missing from the dictionary to avatars.json. */
  initAvatarDictionary(): Promise<BoothResult<AvatarInitResult>> {
    return initAvatarDictionary(this.ctx);
  }

  /** Opt-in download settings from this service's environment (`downloadDir` replaces BOOTH_MCP_DOWNLOAD_DIR). */
  downloadConfig(options: DownloadOptions = {}): DownloadConfig {
    const env = options.downloadDir === undefined ? this.env : { ...this.env, BOOTH_MCP_DOWNLOAD_DIR: options.downloadDir };
    return getDownloadConfig(env);
  }

  /** `booth_download` / CLI `download`: save one purchased file inside the download directory (never overwrites). */
  downloadPurchase(input: DownloadPurchaseInput, options: DownloadOptions = {}): Promise<BoothResult<DownloadResult>> {
    const deps = { redirectReader: this.redirectReader, fetchImpl: this.downloadFetch, config: this.downloadConfig(options) };
    return downloadPurchaseFile(deps, input);
  }
}

function writeWarning(message: string): void {
  process.stderr.write(`booth-library-mcp: ${message}\n`);
}

function isRedirectReader(reader: BoothReader): reader is BoothReader & BoothRedirectReader {
  return typeof (reader as Partial<BoothRedirectReader>).getRedirectLocation === "function";
}

function isAccountSettingsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "accounts.booth.pm" && /^\/settings\/?$/u.test(url.pathname);
  } catch {
    return false;
  }
}
