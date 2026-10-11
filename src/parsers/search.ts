/**
 * Parser for public BOOTH search / browse result pages (booth.pm/{lang}/search/{q}, /items?q=, /browse/{category}).
 *
 * Selectors are verified against the real capture tests/fixtures/public/search.html (2026-10-12, see its README):
 * `li.item-card` with `data-product-*` attributes, `.item-card__title-anchor--multiline`, `.item-card__shop-name`,
 * `.item-card__thumbnail-image[data-original]`, `.pager`, `<b>対象商品 N 件</b>` and `p.u-tpg-caption1`.
 */
import type { Cheerio, CheerioAPI } from "cheerio";
import {
  assertNotSignInPage,
  changed,
  extractItemId,
  loadDocument,
  normalizeText,
  parsePager,
  parsePositiveInt,
  resolveUrl,
  textOrNull,
  type Element,
  type PageInfo,
} from "./buyer-common.js";

export interface SearchItem {
  readonly item_id: string;
  readonly name: string;
  readonly shop_name: string | null;
  readonly shop_subdomain: string | null;
  readonly price: number | null;
  readonly category_id: number | null;
  readonly thumbnail_url: string | null;
  readonly url: string;
}

export interface SearchPage extends PageInfo {
  readonly items: readonly SearchItem[];
  readonly total_count: number | null;
}

const CARD_SELECTOR = "li.item-card";
const TITLE_SELECTOR = ".item-card__title-anchor--multiline, .item-card__title a[href]";
// Layout markers present on the real result page even when the card list is empty.
const LAYOUT_SELECTOR = ".l-market-grid, .market-items, #js-search-option-badges, #js-detail-search-sidebar";
const TOTAL_PATTERNS = [/対象商品\s*([\d,]+)\s*件/u, /商品は\s*([\d,]+)\s*件あります/u];

export function parseSearchPage(html: string, finalUrl: string): SearchPage {
  const $ = loadDocument(html);
  assertNotSignInPage($, finalUrl);
  const cards = $(CARD_SELECTOR).toArray();
  const totalCount = parseTotalCount($);
  const pager = parsePager($, finalUrl);
  if (cards.length === 0) return emptyPage($, finalUrl, pager, totalCount);
  const items = cards.map((node) => parseCard($(node), finalUrl));
  return { items, ...pager, total_count: totalCount };
}

function emptyPage($: CheerioAPI, finalUrl: string, pager: PageInfo, totalCount: number | null): SearchPage {
  const recognised = $(LAYOUT_SELECTOR).length > 0 || totalCount !== null;
  if (!recognised) throw changed("検索結果ページとして認識できません。", finalUrl);
  if (pager.page === 1 && totalCount !== null && totalCount > 0) {
    throw changed("検索結果の件数はありますが商品カードが見つかりません。", finalUrl);
  }
  return {
    items: [],
    page: pager.page,
    last_page: pager.page === 1 ? 1 : null,
    has_next: false,
    total_count: totalCount,
  };
}

function parseCard(card: Cheerio<Element>, finalUrl: string): SearchItem {
  const title = card.find(TITLE_SELECTOR).first();
  const href = title.attr("href") ?? card.find('a[href*="/items/"]').first().attr("href");
  const itemId = validId(card.attr("data-product-id")) ?? extractItemId(href, finalUrl);
  if (itemId === null) throw changed("検索結果の商品カードから商品 ID を取得できません。", finalUrl);
  const name = textOrNull(title.text()) ?? textOrNull(card.attr("data-product-name"));
  if (name === null) throw changed(`検索結果の商品 ${itemId} の名前が見つかりません。`, finalUrl);
  return {
    item_id: itemId,
    name,
    shop_name: textOrNull(card.find(".item-card__shop-name").first().text()),
    shop_subdomain: textOrNull(card.attr("data-product-brand")),
    price: parsePrice(card),
    category_id: parsePositiveInt(card.attr("data-product-category")),
    thumbnail_url: resolveUrl(card.find(".item-card__thumbnail-image").first().attr("data-original"), finalUrl)?.href ?? null,
    url: resolveUrl(href, finalUrl)?.href ?? `https://booth.pm/ja/items/${itemId}`,
  };
}

function validId(value: string | undefined): string | null {
  const id = normalizeText(value);
  return /^\d+$/u.test(id) ? id : null;
}

/** `data-product-price` is numeric (0 for free items); fall back to the displayed `¥ 1,700~`. */
function parsePrice(card: Cheerio<Element>): number | null {
  const attribute = normalizeText(card.attr("data-product-price"));
  if (/^\d+$/u.test(attribute)) return Number(attribute);
  const shown = /[¥￥]\s*([\d,]+)/u.exec(card.find(".price").first().text())?.[1];
  return shown === undefined ? null : Number(shown.replaceAll(",", ""));
}

function parseTotalCount($: CheerioAPI): number | null {
  const text = normalizeText($("body").text());
  for (const pattern of TOTAL_PATTERNS) {
    const match = pattern.exec(text)?.[1];
    if (match !== undefined) return Number(match.replaceAll(",", ""));
  }
  return null;
}
