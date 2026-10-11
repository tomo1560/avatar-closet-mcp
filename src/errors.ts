export const boothErrorCodes = [
  "AUTH_REQUIRED",
  "NOT_FOUND",
  "BOOTH_CHANGED",
  "RATE_LIMITED",
  "NETWORK_ERROR",
  "INVALID_INPUT",
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

/**
 * Converts any thrown value into a BoothError.
 * Only the first line of a foreign error message is kept: Playwright appends a multi-line
 * "Call log" that can include request headers (cookies), which must never reach the client.
 */
export function asBoothError(error: unknown, sourceUrl?: string): BoothError {
  if (error instanceof BoothError) return error;
  return new BoothError("NETWORK_ERROR", firstLineOf(error), sourceUrl);
}

export function firstLineOf(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const firstLine = message.split("\n", 1)[0]?.trim();
  return firstLine ? firstLine : "不明なエラーが発生しました。";
}
