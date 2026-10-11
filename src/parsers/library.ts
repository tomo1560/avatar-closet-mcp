/**
 * Parsers for accounts.booth.pm/library and accounts.booth.pm/library/gifts (same markup).
 *
 * TODO(PLAN §7-1): verify against real page. The structure is reconstructed from third-party parsers that
 * agree on the 2026 markup (see tests/fixtures/buyer/library.html for the full source list).
 */
import type { Cheerio, CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import {
  assertAccountsPage,
  assertNotSignInPage,
  changed,
  downloadIdsWithin,
  extractDownloadLinks,
  extractItemId,
  findCards,
  isShopHost,
  loadDocument,
  parsePager,
  requireMain,
  resolveUrl,
  textOrNull,
  type Card,
  type PageInfo,
} from "./buyer-common.js";

export interface LibraryDownloadable {
  readonly downloadable_id: string;
  readonly file_name: string | null;
  /** Always null on library pages: no source shows variation names there (PLAN §7-13). */
  readonly variation_name: string | null;
}

export interface LibraryItem {
  readonly item_id: string;
  readonly name: string;
  readonly item_url: string;
  readonly shop_name: string | null;
  readonly shop_url: string | null;
  readonly thumbnail_url: string | null;
  readonly downloadables: readonly LibraryDownloadable[];
}

export interface LibraryPage extends PageInfo {
  readonly items: readonly LibraryItem[];
}

const LIBRARY_PATH = /^\/library\/?$/u;
const GIFTS_PATH = /^\/library\/gifts\/?$/u;
// TODO(PLAN §7-1): verify against real page. studio-projecta/library-finder-for-booth extension/content.js
// (div.bg-white.p-16), ribeKim/booth-library-manager utils/parser.ts, Hoard tests/test_readers.py BOOTH_2026.
const CARD_SELECTOR = "div.bg-white.p-16";
// TODO(PLAN §7-1): verify against real page. iamlinggggg/cl-booth-library-manager src/scraper.lisp
// (a[href*='/items/'] div.font-bold), studio-projecta content.js (.font-bold.break-all).
const NAME_SELECTOR = 'a[href*="/items/"] .font-bold';
// TODO(PLAN §7-1): verify against real page. Myrkie/BoothDownloader BoothPageParser.cs, studio-projecta content.js,
// cl-booth scraper.lisp (img.l-library-item-thumbnail).
const THUMBNAIL_SELECTOR = "img.l-library-item-thumbnail";
// TODO(PLAN §7-1): verify against real page. studio-projecta content.js, cl-booth scraper.lisp (.text-text-gray600).
const SHOP_NAME_SELECTOR = ".text-text-gray600";

export function parseLibraryPage(html: string, finalUrl: string): LibraryPage {
  return parseLibraryLikePage(html, finalUrl, LIBRARY_PATH, "ライブラリ");
}

export function parseGiftsPage(html: string, finalUrl: string): LibraryPage {
  return parseLibraryLikePage(html, finalUrl, GIFTS_PATH, "ギフト");
}

function parseLibraryLikePage(html: string, finalUrl: string, path: RegExp, label: string): LibraryPage {
  const $ = loadDocument(html);
  assertNotSignInPage($, finalUrl);
  assertAccountsPage(finalUrl, path, label);
  const main = requireMain($, finalUrl, label);
  const cards = findCards($, main, (href) => extractItemId(href, finalUrl), CARD_SELECTOR);
  assertNoOrphanDownloads($, main, cards, finalUrl, label);
  const items = mergeByItemId(cards.map((card) => parseCard($, card, finalUrl, label)));
  return { items, ...parsePager($, finalUrl) };
}

/** Download buttons outside every detected card mean the card detection no longer matches the markup. */
function assertNoOrphanDownloads(
  $: CheerioAPI,
  main: Cheerio<Element>,
  cards: readonly Card[],
  finalUrl: string,
  label: string,
): void {
  const covered = new Set(cards.flatMap((card) => [...downloadIdsWithin($, card.element)]));
  const orphaned = [...downloadIdsWithin($, main)].filter((id) => !covered.has(id));
  if (orphaned.length > 0) {
    throw changed(`${label}ページでダウンロードボタンを商品に対応付けられませんでした。`, finalUrl);
  }
}

function parseCard($: CheerioAPI, card: Card, finalUrl: string, label: string): LibraryItem {
  const name = cardName($, card, finalUrl);
  if (name === null) throw changed(`${label}ページで商品 ${card.id} の名前が見つかりません。`, finalUrl);
  const shop = cardShop($, card.element, finalUrl);
  return {
    item_id: card.id,
    name,
    item_url: cardItemUrl($, card, finalUrl),
    shop_name: shop.name,
    shop_url: shop.url,
    thumbnail_url: cardThumbnail(card.element, finalUrl),
    downloadables: extractDownloadLinks($, card.element).map((link) => ({ ...link, variation_name: null })),
  };
}

function itemAnchors($: CheerioAPI, card: Card, finalUrl: string): Cheerio<Element>[] {
  return card.element
    .find("a[href]")
    .toArray()
    .map((node) => $(node))
    .filter((anchor) => extractItemId(anchor.attr("href"), finalUrl) === card.id);
}

function cardName($: CheerioAPI, card: Card, finalUrl: string): string | null {
  const preferred = textOrNull(card.element.find(NAME_SELECTOR).first().text());
  if (preferred !== null) return preferred;
  const texts = itemAnchors($, card, finalUrl)
    .map((anchor) => textOrNull(anchor.text()))
    .filter((text): text is string => text !== null)
    .sort((left, right) => right.length - left.length);
  return texts[0] ?? null;
}

function cardItemUrl($: CheerioAPI, card: Card, finalUrl: string): string {
  const href = itemAnchors($, card, finalUrl)[0]?.attr("href");
  return resolveUrl(href, finalUrl)?.href ?? `https://booth.pm/ja/items/${card.id}`;
}

/** The shop is the first link to a shop subdomain that is not an item link (Hoard hoard/library.py BOOTH_JS). */
function cardShop($: CheerioAPI, card: Cheerio<Element>, finalUrl: string): { name: string | null; url: string | null } {
  for (const node of card.find("a[href]").toArray()) {
    const anchor = $(node);
    const url = resolveUrl(anchor.attr("href"), finalUrl);
    if (!url || !isShopHost(url.hostname) || extractItemId(url.href, finalUrl) !== null) continue;
    const name = textOrNull(anchor.find(SHOP_NAME_SELECTOR).first().text()) ?? textOrNull(anchor.text());
    return { name, url: `https://${url.hostname}/` };
  }
  return { name: textOrNull(card.find(SHOP_NAME_SELECTOR).first().text()), url: null };
}

function cardThumbnail(card: Cheerio<Element>, finalUrl: string): string | null {
  const preferred = card.find(THUMBNAIL_SELECTOR).first();
  const image = preferred.length > 0 ? preferred : card.find("img").first();
  const candidates = [image.attr("data-original"), image.attr("data-src"), image.attr("src")];
  const source = candidates.find((value) => value !== undefined && value.trim() !== "" && !value.startsWith("data:"));
  return resolveUrl(source, finalUrl)?.href ?? null;
}

/** The same item can appear in several cards (one per purchase); keep the first and append new files. */
function mergeByItemId(items: readonly LibraryItem[]): LibraryItem[] {
  const merged = new Map<string, LibraryItem>();
  for (const item of items) {
    const existing = merged.get(item.item_id);
    merged.set(item.item_id, existing ? mergeItems(existing, item) : item);
  }
  return [...merged.values()];
}

function mergeItems(first: LibraryItem, second: LibraryItem): LibraryItem {
  const known = new Set(first.downloadables.map((file) => file.downloadable_id));
  return {
    ...first,
    shop_name: first.shop_name ?? second.shop_name,
    shop_url: first.shop_url ?? second.shop_url,
    thumbnail_url: first.thumbnail_url ?? second.thumbnail_url,
    downloadables: [...first.downloadables, ...second.downloadables.filter((file) => !known.has(file.downloadable_id))],
  };
}
