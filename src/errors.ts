export const boothErrorCodes = [
  "AUTH_REQUIRED",
  "NOT_FOUND",
  "BOOTH_CHANGED",
  "RATE_LIMITED",
  "NETWORK_ERROR",
  "INVALID_INPUT",
  "INTERNAL_ERROR",
] as const;

export type BoothErrorCode = (typeof boothErrorCodes)[number];

export class BoothError extends Error {
  readonly code: BoothErrorCode;
  readonly sourceUrl: string | undefined;

  constructor(code: BoothErrorCode, message: string, sourceUrl?: string) {
    super(message);
    this.name = "BoothError";
    this.code = code;
    this.sourceUrl = sourceUrl;
  }
}

/** Socket / DNS errno names (Node) and undici's `UND_ERR_*` codes. */
const NETWORK_ERRNO: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "EPROTO",
]);
const ERRNO_NAME = /^[A-Z][A-Z0-9_]{1,40}$/u;
/** Playwright prefixes API errors with the failing call, e.g. `apiRequestContext.get: …`. */
const PLAYWRIGHT_CALL = /^(?:apiRequestContext|apiResponse|request|browserContext|browserType|page)\.\w+:/u;
const GENERIC_INTERNAL = "avatar-closet-mcp の内部でエラーが発生しました。再実行しても解決しない場合は報告してください。";

/**
 * Converts any thrown value into a BoothError without leaking local paths, cookies or stacks:
 * - network failures (errno such as ECONNRESET, `fetch failed`, Playwright API errors) → NETWORK_ERROR;
 * - local file-system errno (EACCES, ENOENT, EPERM, ENOSPC …) → INTERNAL_ERROR naming only the code;
 * - anything else → INTERNAL_ERROR with a generic message.
 * Only the first line of a Playwright message is kept: its multi-line "Call log" can include request
 * headers (cookies), which must never reach the client.
 */
export function asBoothError(error: unknown, sourceUrl?: string): BoothError {
  if (error instanceof BoothError) return error;
  const code = errnoCodeOf(error);
  if (code !== undefined && isNetworkErrno(code)) {
    return new BoothError("NETWORK_ERROR", `接続に失敗しました（${code}）。しばらく待ってから再試行してください。`, sourceUrl);
  }
  if (isPlaywrightOrFetchError(error)) return new BoothError("NETWORK_ERROR", firstLineOf(error), sourceUrl);
  if (code !== undefined) return localIoError(code);
  return new BoothError("INTERNAL_ERROR", GENERIC_INTERNAL);
}

/** A local file operation failed. Names only the errno code: paths contain the OS user name. */
export function localIoError(code: string): BoothError {
  const shown = ERRNO_NAME.test(code) ? code : "UNKNOWN";
  return new BoothError(
    "INTERNAL_ERROR",
    `ローカルファイルの操作に失敗しました（${shown}）。保存先の権限・空き容量・ファイルの状態を確認してください。`,
  );
}

export function firstLineOf(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const firstLine = message.split("\n", 1)[0]?.trim();
  return firstLine ? firstLine : "不明なエラーが発生しました。";
}

/** errno-style `code` of the error or of its `cause` (fetch wraps socket errors in `TypeError: fetch failed`). */
export function errnoCodeOf(error: unknown): string | undefined {
  return ownErrnoCode(error) ?? ownErrnoCode(causeOf(error));
}

function ownErrnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error as { code: unknown };
  return typeof code === "string" && ERRNO_NAME.test(code) ? code : undefined;
}

function causeOf(error: unknown): unknown {
  return error instanceof Error ? error.cause : undefined;
}

function isNetworkErrno(code: string): boolean {
  return NETWORK_ERRNO.has(code) || code.startsWith("UND_ERR_");
}

function isPlaywrightOrFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  if (error instanceof TypeError && error.message === "fetch failed") return true;
  return PLAYWRIGHT_CALL.test(error.message);
}
