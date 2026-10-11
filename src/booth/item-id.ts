import { BoothError } from "../errors.js";

/** BOOTH item ids are positive decimal integers; 12 digits keeps them well inside `Number.MAX_SAFE_INTEGER`. */
const ITEM_ID_PATTERN = /^[1-9]\d{0,11}$/;
const MAX_ITEM_ID = 999_999_999_999;
const BOOTH_HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)?booth\.pm$/;
/** `/items/{id}`, optionally prefixed by a language (`/ja`, `/en`, `/zh-cn`) and optionally ending in `.json`. */
const ITEM_PATH_PATTERN = /^\/(?:[a-z]{2}(?:-[a-z]{2,4})?\/)?items\/(\d{1,12})(?:\.json)?\/?$/i;
const MAX_INPUT_LENGTH = 2_048;
const MAX_ECHO_LENGTH = 80;

/** True when `value` is a canonical item id string (digits only, no leading zero, at most 12 digits). */
export function isItemId(value: string): boolean {
  return ITEM_ID_PATTERN.test(value);
}

/**
 * Strictly normalizes a bare item id (number or digit string) to its canonical decimal string.
 * Does not accept URLs. Use this before an item id is joined into a file path.
 */
export function toItemId(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ITEM_ID) {
      throw invalidInput(`商品 ID が不正です: ${String(value)}（12 桁以内の正の整数を指定してください）。`);
    }
    return String(value);
  }
  if (typeof value !== "string" || !isItemId(value)) {
    throw invalidInput(`商品 ID が不正です: "${echo(String(value))}"（12 桁以内の数字のみを指定してください）。`);
  }
  return value;
}

/**
 * Accepts an item id (`123`, `"123"`) or a BOOTH item URL
 * (`https://booth.pm/ja/items/123`, `https://booth.pm/items/123`, `https://shop.booth.pm/items/123`,
 * with optional query/hash) and returns the item id as a decimal string.
 */
export function parseItemId(input: string | number): string {
  if (typeof input === "number") return toItemId(input);
  if (typeof input !== "string") throw invalidInput("商品 ID または商品 URL を文字列か数値で指定してください。");

  const trimmed = input.trim();
  if (trimmed.length === 0) throw invalidInput("商品 ID または商品 URL が空です。");
  if (trimmed.length > MAX_INPUT_LENGTH) throw invalidInput("商品 ID または商品 URL が長すぎます。");
  if (/^\d+$/.test(trimmed)) return toItemId(trimmed);
  return parseItemUrl(trimmed);
}

function parseItemUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalidUrl(input);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw invalidUrl(input);
  if (url.username || url.password || url.port) throw invalidUrl(input);
  if (!BOOTH_HOST_PATTERN.test(url.hostname)) throw invalidUrl(input);

  const id = ITEM_PATH_PATTERN.exec(url.pathname)?.[1];
  if (!id) throw invalidUrl(input);
  return toItemId(id);
}

function invalidUrl(input: string): BoothError {
  return invalidInput(
    `BOOTH の商品 ID または商品 URL ではありません: "${echo(input)}"` +
      "（例: 123456, https://booth.pm/ja/items/123456, https://shop.booth.pm/items/123456）。",
  );
}

function invalidInput(message: string): BoothError {
  return new BoothError("INVALID_INPUT", message);
}

function echo(value: string): string {
  return value.length > MAX_ECHO_LENGTH ? `${value.slice(0, MAX_ECHO_LENGTH)}...` : value;
}
