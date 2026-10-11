import { asBoothError, type BoothErrorCode } from "../errors.js";

/** Success. */
export const EXIT_OK = 0;
/** `status` only: not signed in (kept from earlier releases for scripts). */
export const EXIT_NOT_LOGGED_IN = 1;

/** Process exit code per error code, so scripts can react without parsing messages. */
export const EXIT_CODES: Readonly<Record<BoothErrorCode, number>> = Object.freeze({
  INVALID_INPUT: 2,
  AUTH_REQUIRED: 3,
  NOT_FOUND: 4,
  RATE_LIMITED: 5,
  NETWORK_ERROR: 6,
  BOOTH_CHANGED: 7,
  INTERNAL_ERROR: 8,
});

/** Exit code for a failed command (anything that is not a BoothError counts as INTERNAL_ERROR). */
export function exitCodeFor(error: unknown): number {
  return EXIT_CODES[asBoothError(error).code];
}

/** Help section listing the exit codes (printed after HELP_TEXT). */
export const EXIT_CODE_HELP = `
終了コード:
  0  成功
  1  status: 未ログイン
  2  入力・使い方の誤り、無効な設定 (INVALID_INPUT)
  3  ログインが必要 (AUTH_REQUIRED)
  4  見つからない (NOT_FOUND)
  5  BOOTH による制限中 (RATE_LIMITED)
  6  通信エラー (NETWORK_ERROR)
  7  BOOTH の仕様変更の可能性 (BOOTH_CHANGED)
  8  内部エラー・ローカルファイルの操作失敗 (INTERNAL_ERROR)
`;
