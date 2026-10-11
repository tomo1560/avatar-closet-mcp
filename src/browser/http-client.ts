import { load } from "cheerio";
import { BoothError, asBoothError, errnoCodeOf } from "../errors.js";
import { getSessionFile } from "../profile.js";
import {
  loadSessionState,
  persistBoothSession,
  readSessionFingerprint,
  sameFingerprint,
  sessionFileExists,
  type SessionFingerprint,
} from "../session-state.js";
import type { BoothReader, BoothRedirectReader, ReadJsonOptions, RedirectLocation } from "./reader.js";
import { backoffDelayMs, isRetryableStatus, MAX_RETRIES } from "./retry.js";
import { createPlaywrightTransport, type BoothTransport, type TransportFactory, type TransportResponse } from "./transport.js";
import { assertAllowedOrigin, BOOTH_ORIGIN, isDownloadableUrl, isSignInUrl, requiresSession, resolveBoothUrl } from "./url-policy.js";

/** Minimum spacing between any two requests (pixiv ToS §14: no excessive / bursty access). */
export const MIN_REQUEST_INTERVAL_MS = 1_000;
/** Largest HTML / JSON body handed to a parser. Real BOOTH pages are far smaller. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const HTML_ACCEPT = "text/html,application/xhtml+xml";
const LOGIN_HINT = "`booth_login` ツールを呼ぶか `npx booth-library-mcp login` を実行してください。";

export interface BoothHttpClientOptions {
  /** Origin for relative paths: https://booth.pm (default) or https://accounts.booth.pm. */
  origin?: string;
  sessionFile?: string;
  minimumIntervalMs?: number;
  /** Injectable for tests. Defaults to a Playwright APIRequestContext. */
  transportFactory?: TransportFactory;
  /** Injectable for tests so rate-limit waits and backoff do not really sleep. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Non-fatal problems (e.g. cookies could not be saved). Defaults to one line on stderr. */
  onWarning?: (message: string) => void;
}

interface ActiveTransport {
  readonly transport: BoothTransport;
  /** Whether the cookie jar came from a saved session. Anonymous jars are never written back. */
  readonly hasSession: boolean;
}

interface FetchedPage {
  readonly body: string;
  readonly url: string;
}

type Task<T> = (url: string, active: ActiveTransport) => Promise<T>;

/**
 * Read-only BOOTH HTTP client: GET only, strictly serial, >= 1 request/second, exponential backoff
 * on 429/503, host allowlist enforced before sending, and cookie write-back for saved sessions.
 * The session is optional: public booth.pm data works anonymously.
 */
export class BoothHttpClient implements BoothReader, BoothRedirectReader {
  private active: ActiveTransport | undefined;
  /** Version of session.json the in-memory cookie jar corresponds to (loaded, or last written by us). */
  private sessionVersion: SessionFingerprint | undefined;
  /** session.json changed on disk (another process logged in / out): reload before the next request. */
  private reloadRequested = false;
  private writeBackWarned = false;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt: number | undefined;
  private readonly origin: string;
  private readonly sessionFile: string;
  private readonly minimumIntervalMs: number;
  private readonly transportFactory: TransportFactory;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly onWarning: (message: string) => void;

  constructor(options: BoothHttpClientOptions = {}) {
    this.origin = options.origin ?? BOOTH_ORIGIN;
    assertAllowedOrigin(this.origin);
    this.sessionFile = options.sessionFile ?? getSessionFile();
    this.minimumIntervalMs = options.minimumIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
    this.transportFactory = options.transportFactory ?? createPlaywrightTransport;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? ((): number => Date.now());
    this.onWarning = options.onWarning ?? defaultWarning;
  }

  read<T>(path: string, parser: (html: string, finalUrl: string) => T): Promise<{ data: T; url: string }> {
    return this.schedule(path, this.origin, async (url, active) => {
      const page = await this.fetchPage(active, url, { Accept: HTML_ACCEPT });
      return { data: parser(page.body, page.url), url: page.url };
    });
  }

  readJson<T>(
    path: string,
    parser: (json: unknown, finalUrl: string) => T,
    options: ReadJsonOptions = {},
  ): Promise<{ data: T; url: string }> {
    return this.schedule(path, options.origin ?? this.origin, async (url, active) => {
      const csrf = options.csrfFrom ? await this.csrfHeaders(active, options.csrfFrom, url) : {};
      const page = await this.fetchPage(active, url, { Accept: "application/json", ...csrf });
      return { data: parser(parseJsonBody(page), page.url), url: page.url };
    });
  }

  getRedirectLocation(url: string): Promise<RedirectLocation> {
    return this.schedule(url, BOOTH_ORIGIN, (target, active) => this.probeRedirect(active, target), true);
  }

  /** Waits for queued requests, then disposes the cookie jar. The next request reloads session.json. */
  async close(): Promise<void> {
    const closing = this.queue.then(() => this.dispose());
    this.queue = closing.catch(() => undefined);
    await closing;
  }

  private schedule<T>(pathOrUrl: string, origin: string, task: Task<T>, downloadableOnly = false): Promise<T> {
    let url: URL;
    try {
      url = resolveBoothUrl(pathOrUrl, origin);
      if (downloadableOnly && !isDownloadableUrl(url)) {
        throw new BoothError("INVALID_INPUT", "https://booth.pm/downloadables/{id} 形式の URL のみ指定できます。");
      }
    } catch (error) {
      return Promise.reject(asBoothError(error));
    }
    const target = url.toString();
    const needsSession = requiresSession(url);
    return this.enqueue(async () => task(target, await this.acquire(needsSession)), target);
  }

  private enqueue<T>(task: () => Promise<T>, sourceUrl: string): Promise<T> {
    const queued = this.queue.then(task).catch((error: unknown) => {
      throw asBoothError(error, sourceUrl);
    });
    this.queue = queued.catch(() => undefined);
    return queued;
  }

  private async acquire(needsSession: boolean): Promise<ActiveTransport> {
    // Logged out or in elsewhere (e.g. CLI `logout` / `login` while the MCP server runs): drop in-memory cookies.
    if (this.active?.hasSession && (this.reloadRequested || !(await sessionFileExists(this.sessionFile)))) await this.dispose();
    if (this.active && (this.active.hasSession || !needsSession)) return this.active;
    const loaded = await loadSessionState(this.sessionFile);
    if (needsSession && !loaded.hasSession) {
      throw new BoothError("AUTH_REQUIRED", `保存された BOOTH セッションがありません。${LOGIN_HINT}`);
    }
    await this.dispose();
    this.active = { transport: await this.transportFactory(loaded.state), hasSession: loaded.hasSession };
    this.sessionVersion = loaded.fingerprint;
    return this.active;
  }

  private async dispose(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    this.sessionVersion = undefined;
    this.reloadRequested = false;
    await active?.transport.close();
  }

  private async fetchPage(active: ActiveTransport, initialUrl: string, headers: Record<string, string>): Promise<FetchedPage> {
    let currentUrl = initialUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await this.send(active, currentUrl, headers);
      try {
        if (isRedirectStatus(response.status)) {
          currentUrl = sameOriginRedirect(response, currentUrl, initialUrl);
          continue;
        }
        assertSuccess(response.status, currentUrl);
        const body = await readCappedBody(response, currentUrl);
        await this.writeBack(active);
        return { body, url: currentUrl };
      } finally {
        await response.dispose();
      }
    }
    throw new BoothError("NETWORK_ERROR", "BOOTH のリダイレクトが多すぎます。", initialUrl);
  }

  private async probeRedirect(active: ActiveTransport, target: string): Promise<RedirectLocation> {
    const response = await this.send(active, target, { Accept: "*/*" });
    try {
      if (!isRedirectStatus(response.status)) {
        assertSuccess(response.status, target);
        await this.writeBack(active);
        return { status: response.status, location: undefined };
      }
      const location = resolveLocation(response.headers.location, target);
      // Never echo `location` (possibly a signed URL) in an error.
      if (!location || isSignInUrl(location)) throw authRequired(target);
      await this.writeBack(active);
      return { status: response.status, location: location.toString() };
    } finally {
      await response.dispose();
    }
  }

  /** One logical request: rate-limit wait, then up to MAX_RETRIES backoff retries on 429/503. */
  private async send(active: ActiveTransport, url: string, headers: Record<string, string>): Promise<TransportResponse> {
    for (let retry = 0; ; retry += 1) {
      await this.waitForInterval();
      let response: TransportResponse;
      try {
        response = await active.transport.get(url, headers);
      } finally {
        this.lastRequestAt = this.now();
      }
      if (!isRetryableStatus(response.status)) return response;
      const retryAfter = response.headers["retry-after"];
      await response.dispose();
      if (retry >= MAX_RETRIES) {
        throw new BoothError("RATE_LIMITED", "BOOTH がリクエストを制限しています。しばらく待ってから再試行してください。", url);
      }
      await this.sleep(backoffDelayMs(retry, retryAfter, this.now()));
    }
  }

  private async waitForInterval(): Promise<void> {
    if (this.lastRequestAt === undefined) return;
    const remaining = this.lastRequestAt + this.minimumIntervalMs - this.now();
    if (remaining > 0) await this.sleep(remaining);
  }

  /**
   * Cookies can rotate on every response, so they are persisted, but only into the session.json they came
   * from: never create it anonymously, never resurrect it after a logout, and never overwrite a file
   * another process wrote meanwhile (that one is reloaded instead). A failure here never fails the request.
   */
  private async writeBack(active: ActiveTransport): Promise<void> {
    if (!active.hasSession || active !== this.active) return;
    try {
      const onDisk = await readSessionFingerprint(this.sessionFile);
      if (onDisk === undefined) return;
      if (!sameFingerprint(onDisk, this.sessionVersion)) {
        this.reloadRequested = true;
        return;
      }
      await persistBoothSession(active.transport, this.sessionFile);
      this.sessionVersion = await readSessionFingerprint(this.sessionFile);
      this.writeBackWarned = false;
    } catch (error) {
      this.warnWriteBackFailure(error);
    }
  }

  /** Once per failure streak; names only the errno code (paths contain the OS user name). */
  private warnWriteBackFailure(error: unknown): void {
    if (this.writeBackWarned) return;
    this.writeBackWarned = true;
    const code = errnoCodeOf(error) ?? "UNKNOWN";
    this.onWarning(`booth-library-mcp: 更新された BOOTH のログイン状態を保存できませんでした（${code}）。取得結果には影響しません。`);
  }

  private async csrfHeaders(active: ActiveTransport, csrfFrom: string, apiUrl: string): Promise<Record<string, string>> {
    const pageUrl = resolveBoothUrl(csrfFrom, new URL(apiUrl).origin).toString();
    const page = await this.fetchPage(active, pageUrl, { Accept: HTML_ACCEPT });
    const token = load(page.body)("meta[name='csrf-token']").attr("content");
    if (!token) throw new BoothError("BOOTH_CHANGED", "BOOTH の CSRF トークンが見つかりません。", page.url);
    return { "X-CSRF-Token": token, Referer: page.url, Origin: new URL(page.url).origin };
  }
}

function defaultWarning(message: string): void {
  process.stderr.write(`${message}\n`);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function resolveLocation(location: string | undefined, currentUrl: string): URL | undefined {
  if (!location) return undefined;
  try {
    return new URL(location, currentUrl);
  } catch {
    return undefined;
  }
}

/** Follows only same-origin, non-sign-in redirects; anything else means the session is not valid. */
function sameOriginRedirect(response: TransportResponse, currentUrl: string, initialUrl: string): string {
  const next = resolveLocation(response.headers.location, currentUrl);
  if (!next || next.origin !== new URL(currentUrl).origin || isSignInUrl(next)) throw authRequired(initialUrl);
  return next.toString();
}

function authRequired(sourceUrl: string): BoothError {
  return new BoothError("AUTH_REQUIRED", `BOOTH へのログインが必要です（未ログインまたはセッション切れ）。${LOGIN_HINT}`, sourceUrl);
}

function assertSuccess(status: number, url: string): void {
  if (status === 404) throw new BoothError("NOT_FOUND", "指定された BOOTH のデータが見つかりません。", url);
  if (status === 401) throw authRequired(url);
  if (status >= 400) throw new BoothError("NETWORK_ERROR", `BOOTH が HTTP ${status} を返しました。`, url);
}

/**
 * The body, unless it exceeds MAX_RESPONSE_BYTES: a declared Content-Length is checked before reading,
 * the actual size after (Playwright buffers the body itself, so this bounds what reaches the parsers).
 */
async function readCappedBody(response: TransportResponse, url: string): Promise<string> {
  const declared = Number(response.headers["content-length"] ?? "");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw tooLargeResponse(url);
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) throw tooLargeResponse(url);
  return body;
}

function tooLargeResponse(url: string): BoothError {
  return new BoothError("BOOTH_CHANGED", `BOOTH の応答が大きすぎます（上限 ${MAX_RESPONSE_BYTES / 1024 / 1024} MiB）。`, url);
}

function parseJsonBody(page: FetchedPage): unknown {
  try {
    return JSON.parse(page.body) as unknown;
  } catch {
    throw new BoothError("BOOTH_CHANGED", "BOOTH の JSON 応答を解釈できません。", page.url);
  }
}
