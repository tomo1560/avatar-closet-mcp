import { z } from "zod";
import type { BoothReader } from "../browser/reader.js";
import { BoothError } from "../errors.js";
import { parseItemId } from "./item-id.js";
import { describeIssues, parseRawBoothItem, type RawBoothItem, type RawBoothVariation } from "./item-json.js";

export const BOOTH_PUBLIC_ORIGIN = "https://booth.pm";

const DEFAULT_DESCRIPTION_MAX_CHARS = 2_000;
const MAX_SUMMARY_IMAGES = 3;
const MAX_TAG_SUGGESTIONS = 20;
const MAX_TERM_LENGTH = 100;
const MAX_SEARCH_PAGE = 5;
const MAX_QUERY_LENGTH = 200;
const MAX_CATEGORY_LENGTH = 50;
const MAX_SEARCH_TAGS = 10;
const MAX_TAG_LENGTH = 100;
const SORT_PATTERN = /^[a-z_]{1,32}$/;
const DOT_SEGMENT_PATTERN = /^\.{1,2}$/;

/**
 * Category ids confirmed against real data (tests/fixtures/public/README.md). BOOTH filters
 * categories by *name* (`/ja/browse/{name}`), so ids are translated before building a URL.
 */
export const KNOWN_CATEGORY_NAMES: Readonly<Record<number, string>> = Object.freeze({
  208: "3Dキャラクター",
  209: "3D衣装",
  210: "3D小道具",
  214: "3Dテクスチャ",
  215: "3Dツール・システム",
  216: "3Dモーション・アニメーション",
  217: "3D装飾品",
  230: "3D髪型",
});

export interface ItemViewerState {
  wished: boolean;
  /** Truthiness of `order`. Null on every purchased digital item seen (2026-10-12), so not an ownership flag. */
  ordered: boolean;
  /** Truthiness of `gift`. Null even on received gifts seen (2026-10-12). */
  gifted: boolean;
  /**
   * Variations whose logged-in `status` is `already_bought_digital`: the versions the viewer bought. Only a fresh
   * logged-in request carries it; the item cache stores the logged-out status instead (src/cache/cacheable-item.ts).
   */
  owned_variation_ids: number[];
}

export interface ItemVariationSummary {
  id: number;
  name: string | null;
  price: number;
  type: string;
  status: string;
  is_free: boolean;
  has_download: boolean;
}

/** Compact, LLM-friendly view of `items/{id}.json`. Never contains download URLs. */
export interface ItemSummary {
  item_id: string;
  name: string;
  url: string;
  /** Display string, e.g. `"¥ 2,500~"`; numeric prices are on `variations`. */
  price: string;
  is_adult: boolean;
  published_at: string | null;
  shop: { name: string; subdomain: string; url: string; verified: boolean };
  category: { id: number; name: string; parent_name: string | null };
  tags: string[];
  variations: ItemVariationSummary[];
  /** Up to 3 original-size image URLs. */
  images: string[];
  wish_lists_count: number | null;
  description: string;
  description_truncated: boolean;
  /** `null` unless the JSON carries viewer-specific (logged-in) state, which only a fresh logged-in request does. */
  viewer: ItemViewerState | null;
}

export interface GetItemResult {
  raw: RawBoothItem;
  summary: ItemSummary;
}

export interface SummarizeOptions {
  descriptionMaxChars?: number | undefined;
}

export interface SearchUrlParams {
  query?: string | undefined;
  /** Category name (e.g. `3D衣装`) or a known category id (see `KNOWN_CATEGORY_NAMES`). */
  category?: string | number | undefined;
  tags?: readonly string[] | undefined;
  /** Passed through as BOOTH's `sort` parameter. TODO(unverified): accepted values are not confirmed. */
  sort?: string | undefined;
  /** 1-5 (PLAN §2.4: a search is at most a few pages). */
  page?: number | undefined;
  only_free?: boolean | undefined;
  /** `true` adds `adult=include` (search is all-ages only by default). */
  adult?: boolean | undefined;
}

export function itemJsonUrl(itemId: string): string {
  return `${BOOTH_PUBLIC_ORIGIN}/ja/items/${parseItemId(itemId)}.json`;
}

/** Fetches and validates `https://booth.pm/ja/items/{id}.json`. 404 → `NOT_FOUND`, schema drift → `BOOTH_CHANGED`. */
export async function getItem(
  reader: BoothReader,
  itemIdOrUrl: string | number,
  options: SummarizeOptions = {},
): Promise<GetItemResult> {
  const itemId = parseItemId(itemIdOrUrl);
  const url = itemJsonUrl(itemId);
  try {
    const { data } = await reader.readJson(url, (json, finalUrl) => parseItemForId(json, itemId, finalUrl));
    return { raw: data, summary: summarizeItem(data, options) };
  } catch (error) {
    if (error instanceof BoothError && error.code === "NOT_FOUND") {
      throw new BoothError(
        "NOT_FOUND",
        `商品 ${itemId} が見つかりません（削除または非公開の可能性があります）。`,
        error.sourceUrl ?? url,
      );
    }
    throw error;
  }
}

/** Runs inside the reader's parser callback, so every failure must be a `BoothError`. */
function parseItemForId(json: unknown, itemId: string, finalUrl: string): RawBoothItem {
  const item = parseRawBoothItem(json, finalUrl);
  if (String(item.id) !== itemId) {
    throw new BoothError("BOOTH_CHANGED", `商品 ${itemId} を要求しましたが BOOTH は商品 ${item.id} を返しました。`, finalUrl);
  }
  return item;
}

export function summarizeItem(raw: RawBoothItem, options: SummarizeOptions = {}): ItemSummary {
  const description = truncateText(raw.description, options.descriptionMaxChars ?? DEFAULT_DESCRIPTION_MAX_CHARS);
  return {
    item_id: String(raw.id),
    name: raw.name,
    url: raw.url,
    price: raw.price,
    is_adult: raw.is_adult,
    published_at: raw.published_at ?? null,
    shop: {
      name: raw.shop.name,
      subdomain: raw.shop.subdomain,
      url: raw.shop.url,
      verified: raw.shop.verified === true,
    },
    category: {
      id: raw.category.id,
      name: raw.category.name,
      parent_name: raw.category.parent?.name ?? null,
    },
    tags: raw.tags.map((tag) => tag.name),
    variations: raw.variations.map(summarizeVariation),
    images: raw.images.slice(0, MAX_SUMMARY_IMAGES).map((image) => image.original),
    wish_lists_count: raw.wish_lists_count ?? null,
    description: description.text,
    description_truncated: description.truncated,
    viewer: viewerState(raw),
  };
}

function summarizeVariation(variation: RawBoothVariation): ItemVariationSummary {
  const files = [...(variation.downloadable?.no_musics ?? []), ...(variation.downloadable?.musics ?? [])];
  return {
    id: variation.id,
    name: variation.name,
    price: variation.price,
    type: variation.type,
    status: variation.status,
    is_free: variation.price === 0 || variation.status === "free_download",
    has_download: files.length > 0,
  };
}

const BOUGHT_DIGITAL_STATUS = "already_bought_digital";

/**
 * The JSON has no explicit signed-in flag. Logged-out responses are `wished: false, order: null, gift: null` with
 * no bought variation, so anything else is treated as viewer state.
 * Verified 2026-10-12 (PLAN §7-8) on the purchased items of one account, fetched logged in: `wished` is a boolean,
 * `order` and `gift` were null on every item (received gifts included), and on all but one purchased item the bought
 * variation had `status: "already_bought_digital"` instead of `addable_to_cart`. That status is the usable,
 * per-variation ownership signal; received gifts do not get it.
 */
function viewerState(raw: RawBoothItem): ItemViewerState | null {
  const owned = raw.variations.filter((variation) => variation.status === BOUGHT_DIGITAL_STATUS).map((variation) => variation.id);
  const hasViewerState = Boolean(raw.wished) || raw.order != null || raw.gift != null || owned.length > 0;
  if (!hasViewerState) return null;
  return { wished: Boolean(raw.wished), ordered: Boolean(raw.order), gifted: Boolean(raw.gift), owned_variation_ids: owned };
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  const codePoints = Array.from(trimmed);
  if (codePoints.length <= maxChars) return { text: trimmed, truncated: false };
  return { text: codePoints.slice(0, Math.max(0, maxChars)).join("").trimEnd(), truncated: true };
}

const tagSuggestionsSchema = z.array(z.string());

/** `GET https://booth.pm/autocomplete/tag.json?term=...` → up to 20 distinct tag names. */
export async function suggestTags(reader: BoothReader, term: string): Promise<string[]> {
  const trimmed = typeof term === "string" ? term.trim() : "";
  if (trimmed.length === 0) throw invalidInput("タグの検索語が空です。");
  if (Array.from(trimmed).length > MAX_TERM_LENGTH) {
    throw invalidInput(`タグの検索語は ${MAX_TERM_LENGTH} 文字以内で指定してください。`);
  }
  const url = `${BOOTH_PUBLIC_ORIGIN}/autocomplete/tag.json?term=${encodeURIComponent(trimmed)}`;
  const { data } = await reader.readJson(url, parseTagSuggestions);
  return data;
}

function parseTagSuggestions(json: unknown, finalUrl: string): string[] {
  const result = tagSuggestionsSchema.safeParse(json);
  if (!result.success) {
    throw new BoothError(
      "BOOTH_CHANGED",
      `BOOTH のタグ候補の形式が想定と異なります（${describeIssues(result.error)}）。`,
      finalUrl,
    );
  }
  const names = result.data.map((name) => name.trim()).filter((name) => name.length > 0);
  return [...new Set(names)].slice(0, MAX_TAG_SUGGESTIONS);
}

/**
 * Builds a BOOTH search URL (HTML; there is no JSON search endpoint):
 * - category → `https://booth.pm/ja/browse/{category name}?q={query}`
 * - query    → `https://booth.pm/ja/search/{query}`
 * - tags only → `https://booth.pm/ja/items?tags[]=...`
 */
export function buildSearchUrl(params: SearchUrlParams): string {
  const query = normalizeQuery(params.query);
  const category = normalizeCategory(params.category);
  const tags = normalizeTags(params.tags);
  if (!query && !category && tags.length === 0) {
    throw invalidInput("検索語・カテゴリ・タグのいずれかを指定してください。");
  }

  const url = new URL(searchPath(query, category), BOOTH_PUBLIC_ORIGIN);
  if (category && query) url.searchParams.append("q", query);
  for (const tag of tags) url.searchParams.append("tags[]", tag);
  if (params.sort !== undefined) url.searchParams.append("sort", normalizeSort(params.sort));
  // TODO(unverified): PLAN §2.2 lists `max_price`; that `max_price=0` means "free only" is not confirmed.
  if (params.only_free) url.searchParams.append("max_price", "0");
  if (params.adult) url.searchParams.append("adult", "include");
  const page = normalizePage(params.page);
  if (page > 1) url.searchParams.append("page", String(page));
  return url.toString();
}

function searchPath(query: string, category: string): string {
  if (category) return `/ja/browse/${encodeURIComponent(category)}`;
  if (query) return `/ja/search/${encodeURIComponent(query)}`;
  return "/ja/items";
}

function normalizeQuery(query: string | undefined): string {
  const trimmed = (query ?? "").trim().replace(/\s+/g, " ");
  if (Array.from(trimmed).length > MAX_QUERY_LENGTH) {
    throw invalidInput(`検索語は ${MAX_QUERY_LENGTH} 文字以内で指定してください。`);
  }
  if (DOT_SEGMENT_PATTERN.test(trimmed)) throw invalidInput("検索語に「.」「..」は指定できません。");
  return trimmed;
}

function normalizeCategory(category: string | number | undefined): string {
  if (category === undefined) return "";
  if (typeof category === "number") {
    const name = KNOWN_CATEGORY_NAMES[category];
    if (!name) throw invalidInput(`未確認のカテゴリ ID です: ${category}（カテゴリ名で指定してください）。`);
    return name;
  }
  const trimmed = category.trim();
  if (Array.from(trimmed).length > MAX_CATEGORY_LENGTH) {
    throw invalidInput(`カテゴリ名は ${MAX_CATEGORY_LENGTH} 文字以内で指定してください。`);
  }
  if (DOT_SEGMENT_PATTERN.test(trimmed) || trimmed.includes("/")) {
    throw invalidInput("カテゴリは「3D衣装」のような BOOTH のカテゴリ名を 1 つ指定してください。");
  }
  return trimmed;
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
  const normalized = [...new Set((tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
  if (normalized.length > MAX_SEARCH_TAGS) throw invalidInput(`タグは ${MAX_SEARCH_TAGS} 個まで指定できます。`);
  if (normalized.some((tag) => Array.from(tag).length > MAX_TAG_LENGTH)) {
    throw invalidInput(`タグは 1 つあたり ${MAX_TAG_LENGTH} 文字以内で指定してください。`);
  }
  return normalized;
}

function normalizeSort(sort: string): string {
  const trimmed = sort.trim();
  if (!SORT_PATTERN.test(trimmed)) throw invalidInput("sort は英小文字と _ のみで指定してください（例: new）。");
  return trimmed;
}

function normalizePage(page: number | undefined): number {
  if (page === undefined) return 1;
  if (!Number.isInteger(page) || page < 1 || page > MAX_SEARCH_PAGE) {
    throw invalidInput(`page は 1〜${MAX_SEARCH_PAGE} の整数で指定してください。`);
  }
  return page;
}

function invalidInput(message: string): BoothError {
  return new BoothError("INVALID_INPUT", message);
}
