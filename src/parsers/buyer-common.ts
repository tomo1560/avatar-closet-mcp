/**
 * Shared, pure helpers for the buyer-side HTML parsers (library, gifts, orders, search).
 *
 * Nothing here performs I/O. Selectors were first taken from third-party projects (cited next to each one) and
 * then checked against real logged-in captures of /library, /library/gifts, /orders and /orders/{id} on 2026-10-12.
 * The structural fallbacks (walking up from links, label/value pairs) stay in place for the next markup change.
 */
import { load, type Cheerio, type CheerioAPI } from "cheerio";
import { BoothError } from "../errors.js";

type NodeOf<C> = C extends Cheerio<infer N> ? N : never;
/** DOM element node. Derived from cheerio's own types: `domhandler` is only a transitive dependency. */
export type Element = NodeOf<ReturnType<Cheerio<never>["children"]>>;
/** Any DOM node (element, text, comment, document). Derived from cheerio's own types like {@link Element}. */
export type AnyNode = NodeOf<ReturnType<Cheerio<never>["contents"]>>;

export const BOOTH_ORIGIN = "https://booth.pm";
export const ACCOUNTS_HOST = "accounts.booth.pm";

export interface PageInfo {
  readonly page: number;
  readonly last_page: number | null;
  readonly has_next: boolean;
}

export interface DownloadLink {
  readonly downloadable_id: string;
  readonly file_name: string | null;
}

export interface Card {
  readonly id: string;
  readonly element: Cheerio<Element>;
}

export type IdExtractor = (href: string | undefined) => string | null;

// PLAN §2.3; Myrkie/BoothDownloader BoothDownloader/src/Miscellaneous/RegexStore.cs (ItemRegex),
// widened from \w to [\w-] so that locale prefixes such as /zh-cn/ match too.
const ITEM_ID_PATTERN = /booth\.pm(?:\/[\w-]+)?\/items\/(\d+)/u;
// Myrkie/BoothDownloader RegexStore.cs (DownloadRegex). The path must end at the id, which rejects
// the BOOTH Library Manager deeplink variant `/downloadables/{id}/deeplink` (Hoard hoard/library.py BOOTH_JS).
const DOWNLOADABLE_PATH_PATTERN = /^\/downloadables\/(\d+)\/?$/u;
// Verified against real page 2026-10-12: library, gifts and order detail all draw download buttons as
// `div.js-download-button[data-href][data-test="downloadable"]` placeholders (as in Soloflighter1010/Hoard-Asset-Manager
// hoard/library.py BOOTH_JS). Plain links are kept as a fallback for older markup (OptoCloud/AssetDownloader
// BoothAccountOrderScraper.cs). The "その他のDL方法" control carries deeplinks only inside its data-dropdown-items JSON.
const DOWNLOAD_CONTROL_SELECTOR = 'a[href*="/downloadables/"], [data-href*="/downloadables/"]';
// Verified against real page 2026-10-12: `.text-14` on library/gifts rows, `.u-text-wrap > b` on order detail rows.
// Fallbacks: `typography-14` (tomacheese/booth-purchased-items-manager src/booth.ts), `u-flex-1 > b` (OptoCloud
// BoothAccountOrderScraper.cs ExtractDownloadable), any `b`.
const FILE_NAME_SELECTOR = '.text-14, [class*="u-text-wrap"] > b, [class*="typography-14"], [class*="u-flex-1"] > b, b';
const CONTROL_LABEL_PATTERN =
  /ダウンロード|ブラウザで開く|その他のDL方法|Download|Open in Browser|Other Downloads/giu;
const RESERVED_SUBDOMAINS = new Set(["accounts", "www", "asset", "manage", "api", "checkout", "s"]);

export function loadDocument(html: string): CheerioAPI {
  return load(html);
}

export function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

export function textOrNull(value: string | undefined): string | null {
  const text = normalizeText(value);
  return text ? text : null;
}

export function resolveUrl(raw: string | undefined, base: string): URL | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

export function isBoothHost(hostname: string): boolean {
  return hostname === "booth.pm" || hostname.endsWith(".booth.pm");
}

export function isShopHost(hostname: string): boolean {
  if (!hostname.endsWith(".booth.pm")) return false;
  const subdomain = hostname.slice(0, -".booth.pm".length);
  return subdomain.length > 0 && !subdomain.includes(".") && !RESERVED_SUBDOMAINS.has(subdomain);
}

export function extractItemId(raw: string | undefined, base: string): string | null {
  const url = resolveUrl(raw, base);
  if (!url || !isBoothHost(url.hostname)) return null;
  return ITEM_ID_PATTERN.exec(`${url.hostname}${url.pathname}`)?.[1] ?? null;
}

/** Relative download paths (`/downloadables/1`) are resolved against booth.pm, not the accounts host. */
export function extractDownloadableId(raw: string | undefined): string | null {
  const url = resolveUrl(raw, BOOTH_ORIGIN);
  if (!url || !isBoothHost(url.hostname) || url.searchParams.has("browse")) return null;
  return DOWNLOADABLE_PATH_PATTERN.exec(url.pathname)?.[1] ?? null;
}

export function parsePositiveInt(value: string | undefined): number | null {
  const text = normalizeText(value).replaceAll(",", "");
  if (!/^\d+$/u.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseYenAmounts(text: string): number[] {
  const amounts: number[] = [];
  for (const pattern of [/[¥￥]\s*(\d[\d,]*)/gu, /(\d[\d,]*)\s*円/gu]) {
    for (const match of text.matchAll(pattern)) {
      const amount = Number((match[1] ?? "").replaceAll(",", ""));
      if (Number.isSafeInteger(amount)) amounts.push(amount);
    }
  }
  return amounts;
}

/** BOOTH shows JST wall-clock times such as `2026/09/14 21:05:33`; returns ISO 8601 with +09:00. */
export function parseJstDateTime(text: string): string | null {
  const match = /(20\d{2})[/.\-年](\d{1,2})[/.\-月](\d{1,2})日?(?:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/u.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const date = `${year}-${(month ?? "").padStart(2, "0")}-${(day ?? "").padStart(2, "0")}`;
  if (!hour || !minute) return date;
  return `${date}T${hour.padStart(2, "0")}:${minute}:${second ?? "00"}+09:00`;
}

export function assertNotSignInPage($: CheerioAPI, finalUrl: string): void {
  const url = resolveUrl(finalUrl, BOOTH_ORIGIN);
  const isSignInUrl =
    url !== null &&
    (url.pathname.includes("/users/sign_in") || url.hostname === "pixiv.net" || url.hostname.endsWith(".pixiv.net"));
  // PLAN §2.1 (form[action="/users/auth/pixiv"]); Hoard hoard/library.py booth_cards (password field check).
  const hasSignInForm =
    $('form[action*="/users/auth/pixiv"], form[action*="/users/sign_in"]').length > 0 ||
    $('input[type="password"]').length > 0;
  if (isSignInUrl || hasSignInForm) {
    throw new BoothError("AUTH_REQUIRED", "BOOTH にログインしていません。booth_login でログインしてください。", finalUrl);
  }
}

export function assertAccountsPage(finalUrl: string, pathPattern: RegExp, label: string): URL {
  const url = resolveUrl(finalUrl, BOOTH_ORIGIN);
  if (!url || url.hostname !== ACCOUNTS_HOST || !pathPattern.test(url.pathname)) {
    throw new BoothError("BOOTH_CHANGED", `${label}ページではない URL に到達しました。`, finalUrl);
  }
  return url;
}

export function requireMain($: CheerioAPI, finalUrl: string, label: string): Cheerio<Element> {
  const main = $("main").first();
  if (main.length === 0) {
    throw new BoothError("BOOTH_CHANGED", `${label}ページの main 要素が見つかりません。`, finalUrl);
  }
  return main;
}

export function changed(message: string, finalUrl: string): BoothError {
  return new BoothError("BOOTH_CHANGED", message, finalUrl);
}

function pageFromHref(raw: string | undefined, base: string): number | null {
  const url = resolveUrl(raw, base);
  if (!url) return null;
  const page = url.searchParams.get("page");
  return page === null ? 1 : parsePositiveInt(page);
}

/**
 * Kaminari-style pager (`.pager li.current`, `a[rel="next"]`, `a.nav-item.last-page`), as on the public
 * tests/fixtures/public/search.html. Verified against real page 2026-10-12 for /library and /orders (first page of
 * several); a single-page /library/gifts renders an empty `div.pager`. The last-page state of an accounts list is
 * not verified yet.
 */
export function parsePager($: CheerioAPI, finalUrl: string): PageInfo {
  const pager = $(".pager").first();
  const scope: Cheerio<AnyNode> = pager.length > 0 ? pager : $.root();
  const urlPage = pageFromHref(finalUrl, BOOTH_ORIGIN) ?? 1;
  const page = parsePositiveInt(pager.find("li.current").first().text()) ?? urlPage;
  const hasNextLink = scope.find('a[rel="next"]').length > 0;
  let lastPage = pageFromHref(scope.find("a.last-page").first().attr("href"), finalUrl);
  if (lastPage === null && !hasNextLink) {
    lastPage = pager.length > 0 ? maxPagerPage($, pager, finalUrl, page) : page;
  }
  return { page, last_page: lastPage, has_next: hasNextLink || (lastPage !== null && page < lastPage) };
}

function maxPagerPage($: CheerioAPI, pager: Cheerio<Element>, base: string, current: number): number {
  let max = current;
  pager.find("a[href]").each((_index, element) => {
    const candidate = pageFromHref($(element).attr("href"), base);
    if (candidate !== null && candidate > max) max = candidate;
  });
  return max;
}

/** Ids linked from inside `element`, or from `element` itself when it is a link (an /orders card is one big link). */
export function idsWithin($: CheerioAPI, element: Cheerio<AnyNode>, idOf: IdExtractor): Set<string> {
  const ids = new Set<string>();
  element.find("a[href]").addBack("a[href]").each((_index, anchor) => {
    const id = idOf($(anchor).attr("href"));
    if (id) ids.add(id);
  });
  return ids;
}

/**
 * Finds one container per entity. The preferred selector is tried first; when it does not isolate
 * exactly one entity per match, fall back to walking up from each link to the largest ancestor that
 * still refers to a single entity (Myrkie/BoothDownloader BoothPageParser.cs FindItemContainers,
 * Hoard hoard/library.py BOOTH_JS) — both adopted this after BOOTH's 2026 layout change.
 */
export function findCards($: CheerioAPI, scope: Cheerio<Element>, idOf: IdExtractor, preferred: string): Card[] {
  const bySelector = cardsFromSelector($, scope, idOf, preferred);
  return bySelector.length > 0 ? bySelector : cardsByWalkUp($, scope, idOf);
}

function cardsFromSelector($: CheerioAPI, scope: Cheerio<Element>, idOf: IdExtractor, selector: string): Card[] {
  const cards: Card[] = [];
  let isolated = true;
  scope.find(selector).each((_index, node) => {
    const element = $(node);
    const ids = [...idsWithin($, element, idOf)];
    if (ids.length > 1) isolated = false;
    const [id] = ids;
    if (ids.length === 1 && id) cards.push({ id, element });
  });
  return isolated ? cards : [];
}

function cardsByWalkUp($: CheerioAPI, scope: Cheerio<Element>, idOf: IdExtractor): Card[] {
  const cards: Card[] = [];
  const seen = new Set<Element>();
  const root = scope.get(0);
  scope.find("a[href]").each((_index, node) => {
    const anchor = $(node);
    const id = idOf(anchor.attr("href"));
    if (!id) return;
    let card: Cheerio<Element> = anchor;
    let parent = anchor.parent();
    while (parent.length > 0 && parent.get(0) !== root && idsWithin($, parent, idOf).size === 1) {
      card = parent;
      parent = parent.parent();
    }
    const element = card.get(0);
    if (!element || seen.has(element)) return;
    seen.add(element);
    cards.push({ id, element: card });
  });
  return cards;
}

export function downloadIdsWithin($: CheerioAPI, element: Cheerio<AnyNode>): Set<string> {
  const ids = new Set<string>();
  element.find(DOWNLOAD_CONTROL_SELECTOR).each((_index, node) => {
    const id = controlDownloadId($(node));
    if (id) ids.add(id);
  });
  return ids;
}

function controlDownloadId(control: Cheerio<Element>): string | null {
  return extractDownloadableId(control.attr("data-href") ?? control.attr("href"));
}

/** Unique downloadable links inside a card, in document order, each with the file name of its row. */
export function extractDownloadLinks($: CheerioAPI, card: Cheerio<Element>): DownloadLink[] {
  const links: DownloadLink[] = [];
  const seen = new Set<string>();
  card.find(DOWNLOAD_CONTROL_SELECTOR).each((_index, node) => {
    const control = $(node);
    const id = controlDownloadId(control);
    if (!id || seen.has(id)) return;
    seen.add(id);
    links.push({ downloadable_id: id, file_name: fileNameOf($, control, card) });
  });
  return links;
}

/**
 * Widens from the control to its row while the row is still about this one file
 * (Hoard hoard/library.py BOOTH_JS), then reads the row's file name.
 */
function fileNameOf($: CheerioAPI, control: Cheerio<Element>, card: Cheerio<Element>): string | null {
  const cardNode = card.get(0);
  let row: Cheerio<Element> = control;
  let parent = control.parent();
  while (parent.length > 0 && parent.get(0) !== cardNode && isSingleFileRow($, parent)) {
    row = parent;
    parent = parent.parent();
  }
  const clone = row.clone();
  clone.find(`${DOWNLOAD_CONTROL_SELECTOR}, button, [data-label]`).remove();
  const named = textOrNull(clone.find(FILE_NAME_SELECTOR).first().text());
  return named ?? textOrNull(clone.text().replace(CONTROL_LABEL_PATTERN, " "));
}

function isSingleFileRow($: CheerioAPI, element: Cheerio<Element>): boolean {
  if (element.find('img, a[href*="/items/"]').length > 0) return false;
  return downloadIdsWithin($, element).size <= 1;
}

/** Value of a `label → next sibling` pair (dt/dd, th/td, or adjacent columns), matched case-insensitively. */
export function findLabeledValue($: CheerioAPI, scope: Cheerio<AnyNode>, labels: readonly string[]): string | null {
  const wanted = new Set(labels.map(normalizeLabel));
  let found: string | null = null;
  scope.find("*").each((_index, node) => {
    const element = $(node);
    if (!wanted.has(normalizeLabel(element.text()))) return undefined;
    const value = textOrNull(element.next().text());
    if (value === null) return undefined;
    found = value;
    return false;
  });
  return found;
}

function normalizeLabel(value: string): string {
  return normalizeText(value).replace(/[:：]$/u, "").trim().toLowerCase();
}
