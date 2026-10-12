import { join } from "node:path";
import type { BoothRedirectReader } from "../browser/reader.js";
import { BOOTH_ORIGIN, isSignInUrl } from "../browser/url-policy.js";
import { BoothError } from "../errors.js";
import { PACKAGE_VERSION } from "../version.js";
import { isAllowedDownloadHost, type DownloadConfig } from "./download-config.js";
import { assertTargetAbsent, isInside, resolveDestinationDir, tooLarge, writeExclusive } from "./download-file.js";
import { fileNameFromUrlPath, parseContentDispositionName, sanitizeFileName } from "./download-filename.js";

export {
  DEFAULT_DOWNLOAD_HOSTS,
  DEFAULT_HEADERS_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  getDownloadConfig,
  isAllowedDownloadHost,
  type DownloadConfig,
  type DownloadEnv,
} from "./download-config.js";
export { MAX_FILE_NAME_BYTES, fileNameFromUrlPath, parseContentDispositionName, sanitizeFileName } from "./download-filename.js";

/*
 * Opt-in purchase download (PLAN §3 booth_download, Phase 3).
 *
 * Flow: GET https://booth.pm/downloadables/{id} with the session (not followed) -> 302 to a short-lived
 * signed URL -> fetch that URL WITHOUT cookies, following at most one further redirect, every hop
 * re-checked against the host allowlist -> stream to `<name>.part` -> publish without overwriting.
 *
 * Source: Myrkie/BoothDownloader BoothDownloader/src/Web/BoothHttpClientManager.cs (redirects disabled
 * to read Location) + src/Miscellaneous/Utils.cs `DownloadFileAsync` (signed URL fetched with
 * `AnonymousHttpClient`: only `adult=t`, no session cookie); tukiminya/omnooth
 * internal/platform/http.go (signed URL fetched with no cookies at all, every redirect hop
 * re-validated, no whole-request timeout because files can be very large);
 * Soloflighter1010/Hoard-Asset-Manager hoard/downloader.py `booth_file_location` (the 302 target is
 * "a short-lived download address"; Hoard itself sends its booth.pm session to *.booth.pm hosts, so
 * it is not evidence either way on cookies).
 * TODO(PLAN §7-4): verify against a real download: signed host(s), whether a second redirect ever
 * happens, Content-Disposition presence, presigned URL lifetime, typical sizes.
 *
 * The signed URL is a bearer credential: it never appears in errors, logs or the return value.
 */

export interface DownloadDeps {
  readonly redirectReader: BoothRedirectReader;
  /** Injectable for tests. Defaults to the global fetch (sends no cookies). */
  readonly fetchImpl?: typeof fetch;
  readonly config: DownloadConfig;
}

export interface DownloadInput {
  /** Digits only (`https://booth.pm/downloadables/{id}`). */
  readonly downloadableId: string;
  readonly variationId?: string | undefined;
  /** Sub-directory (relative, or absolute inside `config.destDir`). Defaults to `config.destDir`. */
  readonly destDir?: string | undefined;
}

export interface DownloadResult {
  readonly path: string;
  readonly file_name: string;
  readonly bytes: number;
  readonly content_type: string | null;
}

interface SignedResponse {
  readonly response: Response;
  /** Every signed URL visited, first to last (used only to derive a file name). */
  readonly urls: readonly URL[];
}

/** The parts of an enabled DownloadConfig the download needs. */
interface DownloadSettings {
  readonly root: string;
  readonly allowedHosts: readonly string[];
  readonly maxBytes: number | null;
  readonly headersTimeoutMs: number;
  readonly idleTimeoutMs: number;
}

interface DownloadIds {
  readonly downloadableId: string;
  readonly variationId: string | undefined;
}

const NUMERIC_ID = /^\d{1,20}$/u;
/** Redirects followed after BOOTH's own 302. */
const MAX_SIGNED_REDIRECTS = 1;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const PRINTABLE_HOST = /^[a-z0-9.-]{1,253}$/u;
const HTML_FILE = /\.html?$/iu;
const LOGIN_HINT = "`booth_login` ツールを呼ぶか `npx avatar-closet-mcp login` を実行してください。";
const SIGNED_REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  Accept: "*/*",
  "Accept-Encoding": "identity",
  "User-Agent": `avatar-closet-mcp/${PACKAGE_VERSION}`,
});

/** Downloads one purchased file into the opt-in download directory. Never overwrites a file. */
export async function downloadPurchase(deps: DownloadDeps, input: DownloadInput): Promise<DownloadResult> {
  const config = requireEnabled(deps.config);
  const ids = validateIds(input);
  const directory = await resolveDestinationDir(config.root, nonEmpty(input.destDir));
  const firstUrl = await locateSignedUrl(deps.redirectReader, ids, config.allowedHosts);
  const controller = new AbortController();
  try {
    const signed = await fetchSigned(deps.fetchImpl ?? fetch, firstUrl, config, controller);
    return await saveResponse(signed, directory, ids.downloadableId, config);
  } finally {
    // Releases the connection when we bail out before consuming the body.
    controller.abort();
  }
}

function requireEnabled(config: DownloadConfig): DownloadSettings {
  if (!config.enabled || config.destDir === null) {
    throw new BoothError("INVALID_INPUT", "ダウンロードは無効です。BOOTH_MCP_ENABLE_DOWNLOAD=1 と BOOTH_MCP_DOWNLOAD_DIR（絶対パス）を設定してください。");
  }
  const { allowedHosts, maxBytes, headersTimeoutMs, idleTimeoutMs } = config;
  return { root: config.destDir, allowedHosts, maxBytes, headersTimeoutMs, idleTimeoutMs };
}

function validateIds(input: DownloadInput): DownloadIds {
  const variationId = nonEmpty(input.variationId);
  if (!NUMERIC_ID.test(input.downloadableId) || (variationId !== undefined && !NUMERIC_ID.test(variationId))) {
    throw new BoothError("INVALID_INPUT", "downloadable_id と variation_id は数字のみで指定してください。");
  }
  return { downloadableId: input.downloadableId, variationId };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function downloadableUrl(ids: DownloadIds): string {
  const query = ids.variationId === undefined ? "" : `?variation_id=${ids.variationId}`;
  return `${BOOTH_ORIGIN}/downloadables/${ids.downloadableId}${query}`;
}

async function locateSignedUrl(reader: BoothRedirectReader, ids: DownloadIds, allowedHosts: readonly string[]): Promise<URL> {
  const source = new URL(downloadableUrl(ids));
  const probe = await reader.getRedirectLocation(source.toString());
  const location = probe.location ? parseLocation(probe.location, source) : null;
  if (location && isSignInUrl(location)) throw authRequired();
  if (!REDIRECT_STATUSES.has(probe.status) || !location) throw unexpectedProbe(probe.status);
  return vetSignedUrl(location, allowedHosts);
}

function unexpectedProbe(status: number): BoothError {
  if (status === 404 || status === 410) return new BoothError("NOT_FOUND", "指定されたダウンロードが見つかりません。");
  if (status === 401 || status === 403) return authRequired();
  return new BoothError("BOOTH_CHANGED", `BOOTH がダウンロード先へのリダイレクトを返しませんでした（HTTP ${status}）。BOOTH の仕様が変わった可能性があります。`);
}

/** Node's "Invalid URL" TypeError carries the input string, so it is never rethrown. */
function parseLocation(location: string, base: URL): URL {
  try {
    return new URL(location, base);
  } catch {
    throw new BoothError("BOOTH_CHANGED", "ダウンロード先 URL を解釈できませんでした。");
  }
}

/** Vets one redirect target. Errors name at most the host, never the path or query. */
function vetSignedUrl(url: URL, allowedHosts: readonly string[]): URL {
  if (isSignInUrl(url)) throw authRequired();
  if (url.protocol !== "https:") throw new BoothError("BOOTH_CHANGED", "https 以外のダウンロード先は拒否しました。");
  if (url.username !== "" || url.password !== "" || url.port !== "") {
    throw new BoothError("BOOTH_CHANGED", "想定外の形式（認証情報・ポート指定付き）のダウンロード先は拒否しました。");
  }
  if (!isAllowedDownloadHost(url.hostname, allowedHosts)) throw hostNotAllowed(url.hostname);
  return url;
}

function hostNotAllowed(host: string): BoothError {
  const shown = PRINTABLE_HOST.test(host) ? `「${host}」` : "";
  return new BoothError(
    "BOOTH_CHANGED",
    `ダウンロード先ホスト${shown}は許可リストにないため拒否しました。信頼できるホストであれば BOOTH_MCP_DOWNLOAD_HOSTS に追加できます。`,
  );
}

function authRequired(): BoothError {
  return new BoothError("AUTH_REQUIRED", `BOOTH へのログインが必要です（未ログインまたはセッション切れ）。${LOGIN_HINT}`);
}

async function fetchSigned(
  fetchImpl: typeof fetch,
  first: URL,
  settings: DownloadSettings,
  controller: AbortController,
): Promise<SignedResponse> {
  let urls: readonly URL[] = [first];
  for (let hop = 0; ; hop += 1) {
    const current = urls[urls.length - 1] ?? first;
    const response = await requestSigned(fetchImpl, current, controller, settings.headersTimeoutMs);
    if (!REDIRECT_STATUSES.has(response.status)) {
      assertSignedSuccess(response);
      return { response, urls };
    }
    discard(response);
    const location = response.headers.get("location");
    if (hop >= MAX_SIGNED_REDIRECTS || !location) {
      throw new BoothError("BOOTH_CHANGED", "ダウンロード先のリダイレクトが想定と異なるため中止しました。");
    }
    urls = [...urls, vetSignedUrl(parseLocation(location, current), settings.allowedHosts)];
  }
}

/**
 * One GET without cookies. Gives up (and aborts the shared controller) when the response headers do not
 * arrive within `headersTimeoutMs`, even if the fetch implementation ignores the abort signal. The body
 * is not covered by this timer; the idle timeout in writeExclusive watches it instead.
 */
async function requestSigned(fetchImpl: typeof fetch, url: URL, controller: AbortController, headersTimeoutMs: number): Promise<Response> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject first: aborting makes the pending fetch reject too, and the race must report the timeout.
      reject(noResponse(headersTimeoutMs));
      controller.abort();
    }, headersTimeoutMs);
  });
  const init: RequestInit = { method: "GET", redirect: "manual", credentials: "omit", headers: SIGNED_REQUEST_HEADERS, signal: controller.signal };
  try {
    return await Promise.race([fetchImpl(url.toString(), init), timedOut]);
  } catch (error) {
    if (error instanceof BoothError) throw error;
    // fetch errors may embed the request URL: never forward their message or cause.
    throw new BoothError("NETWORK_ERROR", "ダウンロード先に接続できませんでした。再実行してください。");
  } finally {
    clearTimeout(timer);
  }
}

function noResponse(timeoutMs: number): BoothError {
  const seconds = Math.max(1, Math.round(timeoutMs / 1_000));
  return new BoothError("NETWORK_ERROR", `ダウンロード先が ${seconds} 秒以内に応答しませんでした。再実行してください。`);
}

function assertSignedSuccess(response: Response): void {
  const { status } = response;
  if (status >= 200 && status < 300) return;
  discard(response);
  if (status === 404 || status === 410) throw new BoothError("NOT_FOUND", `ダウンロードファイルが見つかりません（HTTP ${status}）。`);
  if (status === 429 || status === 503) {
    throw new BoothError("RATE_LIMITED", `ダウンロード先が混雑しています（HTTP ${status}）。しばらく待ってから再実行してください。`);
  }
  if (status === 401 || status === 403) {
    throw new BoothError("NETWORK_ERROR", `ダウンロード先がアクセスを拒否しました（HTTP ${status}）。URL の有効期限切れの可能性があるため再実行してください。`);
  }
  throw new BoothError("NETWORK_ERROR", `ダウンロード先が HTTP ${status} を返しました。`);
}

function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function saveResponse(
  signed: SignedResponse,
  directory: string,
  downloadableId: string,
  settings: DownloadSettings,
): Promise<DownloadResult> {
  const { response } = signed;
  const { maxBytes, idleTimeoutMs } = settings;
  const contentType = mediaType(response.headers.get("content-type"));
  const fileName = pickFileName(response, signed.urls, downloadableId);
  if (contentType === "text/html" && !HTML_FILE.test(fileName)) {
    throw new BoothError("BOOTH_CHANGED", "ファイルではなく Web ページが返されました。BOOTH の仕様が変わったか、ファイルが公開停止された可能性があります。");
  }
  const expectedBytes = declaredLength(response);
  if (maxBytes !== null && expectedBytes !== null && expectedBytes > maxBytes) throw tooLarge(maxBytes);
  const target = join(directory, fileName);
  if (target === directory || !isInside(directory, target)) {
    throw new BoothError("INVALID_INPUT", "保存先のファイル名が不正です。");
  }
  await assertTargetAbsent(target, fileName);
  const bytes = await writeExclusive(response.body, target, fileName, { maxBytes, expectedBytes, idleTimeoutMs });
  return Object.freeze({ path: target, file_name: fileName, bytes, content_type: contentType });
}

/** Content-Disposition first, then the last path segment of each signed URL (last hop first). */
function pickFileName(response: Response, urls: readonly URL[], downloadableId: string): string {
  const candidates = [
    parseContentDispositionName(response.headers.get("content-disposition")),
    ...[...urls].reverse().map((url) => fileNameFromUrlPath(url)),
  ];
  for (const candidate of candidates) {
    const sanitized = candidate === null ? "" : sanitizeFileName(candidate, "");
    if (sanitized !== "") return sanitized;
  }
  return `booth-${downloadableId}.bin`;
}

function mediaType(value: string | null): string | null {
  const type = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return type === "" ? null : type;
}

/** Content-Length of an un-encoded body, or null when absent / not comparable to the bytes we write. */
function declaredLength(response: Response): number | null {
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase() ?? "identity";
  const length = response.headers.get("content-length")?.trim() ?? "";
  if (encoding !== "identity" || !/^\d{1,15}$/u.test(length)) return null;
  return Number(length);
}
