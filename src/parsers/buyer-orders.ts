/**
 * Parsers for accounts.booth.pm/orders and accounts.booth.pm/orders/{id} (the buyer's own orders).
 *
 * TODO(PLAN §7-1): verify against real page. LOW confidence: the only structural source is
 * OptoCloud/AssetDownloader (2024-07) BoothAccountOrdersScraper.cs / BoothAccountOrderScraper.cs, plus the
 * item block class from Myrkie/BoothDownloader BoothPageParser.cs (September 2026). The parsers therefore key on
 * links (order ids, item ids, downloadable ids) and on label texts, and only use classes as preferred hints.
 *
 * Privacy: shipping/contact fields (name, address, phone, e-mail) are never selected. Free-text fields that are
 * returned (status, payment method) are additionally passed through redactSensitiveText.
 */
import type { Cheerio, CheerioAPI } from "cheerio";
import { redactSensitiveText } from "../privacy.js";
import {
  ACCOUNTS_HOST,
  assertAccountsPage,
  assertNotSignInPage,
  changed,
  extractDownloadLinks,
  extractItemId,
  findCards,
  findLabeledValue,
  idsWithin,
  loadDocument,
  parseJstDateTime,
  parsePager,
  parseYenAmounts,
  requireMain,
  resolveUrl,
  textOrNull,
  type AnyNode,
  type Card,
  type Element,
  type PageInfo,
} from "./buyer-common.js";

export interface OrderSummary {
  readonly order_id: string;
  readonly ordered_at: string | null;
  readonly total_price: number | null;
  readonly status: string | null;
  readonly item_names: readonly string[];
}

export interface OrdersPage extends PageInfo {
  readonly orders: readonly OrderSummary[];
}

export interface OrderDownloadable {
  readonly downloadable_id: string;
  readonly file_name: string | null;
  readonly variation_name: string | null;
}

export interface OrderItem {
  readonly item_id: string;
  readonly name: string;
  readonly variation_name: string | null;
  readonly price: number | null;
  readonly downloadables: readonly OrderDownloadable[];
}

export interface OrderDetail {
  readonly order_id: string;
  readonly ordered_at: string | null;
  readonly status: string | null;
  readonly payment_method: string | null;
  readonly total_price: number | null;
  readonly items: readonly OrderItem[];
}

const ORDERS_PATH = /^\/orders\/?$/u;
const ORDER_DETAIL_PATH = /^\/orders\/(\d+)\/?$/u;
// TODO(PLAN §7-1): verify against real page. OptoCloud BoothAccountOrdersScraper.cs (div.l-orders-index > div.sheet).
const ORDER_CARD_SELECTOR = ".l-orders-index > .sheet";
// TODO(PLAN §7-1): verify against real page. OptoCloud BoothAccountOrdersScraper.cs (div.u-tpg-caption1 = item name).
const ORDER_ITEM_NAME_SELECTOR = '[class*="u-tpg-caption1"]';
// TODO(PLAN §7-1): verify against real page. Not backed by any source (status badge is a guess).
const STATUS_SELECTOR = '.badge, [class*="status"]';
// TODO(PLAN §7-1): verify against real page. Myrkie/BoothDownloader BoothPageParser.cs
// ("sheet sheet--p400 mobile:pt-[13px] mobile:px-16 mobile:pb-8"); OptoCloud BoothAccountOrderScraper.cs
// (div.l-order-detail-by-shop, div.u-tpg-title4 > b > a).
const DETAIL_SCOPE_SELECTOR = ".l-order-detail-by-shop";
const DETAIL_ITEM_SELECTOR = '[class*="sheet--p400"]';
const DETAIL_NAME_SELECTOR = '[class*="u-tpg-title4"] a[href]';
// TODO(PLAN §7-1): verify against real page. Not backed by any source: no project extracts variation names.
const DETAIL_VARIATION_SELECTOR = '[class*="variation"]';
const TOTAL_LABELS = ["合計", "合計金額", "お支払い金額", "お支払金額", "支払金額", "total"];
// Label texts: OptoCloud BoothAccountOrderScraper.cs reads "order number" / "created at" (English UI).
const DETAIL_LABELS = {
  orderId: ["注文番号", "order number"],
  orderedAt: ["注文日時", "注文日", "購入日時", "created at", "order date"],
  status: ["ステータス", "注文ステータス", "状態", "お支払い状況", "支払い状況", "支払状況", "status"],
  paymentMethod: ["お支払い方法", "お支払方法", "支払い方法", "支払方法", "決済方法", "payment method"],
  total: TOTAL_LABELS,
} as const;

export function parseOrdersPage(html: string, finalUrl: string): OrdersPage {
  const $ = loadDocument(html);
  assertNotSignInPage($, finalUrl);
  assertAccountsPage(finalUrl, ORDERS_PATH, "注文履歴");
  const main = requireMain($, finalUrl, "注文履歴");
  const orderIdOf = (href: string | undefined): string | null => extractOrderId(href, finalUrl);
  const cards = findCards($, main, orderIdOf, ORDER_CARD_SELECTOR);
  if (cards.length === 0 && idsWithin($, main, (href) => extractItemId(href, finalUrl)).size > 0) {
    throw changed("注文履歴ページで商品は見つかりましたが注文番号のリンクが見つかりません。", finalUrl);
  }
  const orders = mergeByOrderId(cards.map((card) => parseOrderCard($, card, finalUrl)));
  return { orders, ...parsePager($, finalUrl) };
}

export function parseOrderDetail(html: string, finalUrl: string): OrderDetail {
  const $ = loadDocument(html);
  assertNotSignInPage($, finalUrl);
  const url = assertAccountsPage(finalUrl, ORDER_DETAIL_PATH, "注文詳細");
  const main = requireMain($, finalUrl, "注文詳細");
  const orderId = ORDER_DETAIL_PATH.exec(url.pathname)?.[1] ?? "";
  const scope = itemScope($, main);
  const cards = findCards($, scope, (href) => extractItemId(href, finalUrl), DETAIL_ITEM_SELECTOR);
  if (cards.length === 0) throw changed("注文詳細ページで商品が見つかりません。", finalUrl);
  const label = (labels: readonly string[]): string | null => findLabeledValue($, main, labels);
  const ordered = label(DETAIL_LABELS.orderedAt);
  const total = label(DETAIL_LABELS.total);
  return {
    order_id: orderId,
    ordered_at: ordered === null ? null : parseJstDateTime(ordered),
    status: masked(label(DETAIL_LABELS.status)),
    payment_method: masked(label(DETAIL_LABELS.paymentMethod)),
    total_price: total === null ? null : (parseYenAmounts(total)[0] ?? null),
    items: cards.map((card) => parseDetailItem($, card, finalUrl)),
  };
}

/** Order links are relative (`/orders/1`) or absolute on accounts.booth.pm (Myrkie/BoothDownloader RegexStore.cs). */
function extractOrderId(href: string | undefined, finalUrl: string): string | null {
  const url = resolveUrl(href, finalUrl);
  if (!url || url.hostname !== ACCOUNTS_HOST) return null;
  return ORDER_DETAIL_PATH.exec(url.pathname)?.[1] ?? null;
}

function parseOrderCard($: CheerioAPI, card: Card, finalUrl: string): OrderSummary {
  const text = card.element.text();
  const labelledTotal = findLabeledValue($, card.element, TOTAL_LABELS);
  const amounts = parseYenAmounts(labelledTotal ?? text);
  return {
    order_id: card.id,
    ordered_at: parseJstDateTime(text),
    total_price: amounts.length > 0 ? Math.max(...amounts) : null,
    status: masked(textOrNull(card.element.find(STATUS_SELECTOR).first().text())),
    item_names: orderItemNames($, card.element, finalUrl),
  };
}

function orderItemNames($: CheerioAPI, card: Cheerio<Element>, finalUrl: string): string[] {
  const fromLinks = card
    .find("a[href]")
    .toArray()
    .filter((node) => extractItemId($(node).attr("href"), finalUrl) !== null)
    .map((node) => textOrNull($(node).text()));
  const fromCaptions = card
    .find(ORDER_ITEM_NAME_SELECTOR)
    .toArray()
    .map((node) => textOrNull($(node).text()));
  const named = fromLinks.some((name) => name !== null) ? fromLinks : fromCaptions;
  return unique(named.filter((name): name is string => name !== null));
}

function mergeByOrderId(orders: readonly OrderSummary[]): OrderSummary[] {
  const merged = new Map<string, OrderSummary>();
  for (const order of orders) {
    const existing = merged.get(order.order_id);
    merged.set(order.order_id, existing ? mergeOrders(existing, order) : order);
  }
  return [...merged.values()];
}

function mergeOrders(first: OrderSummary, second: OrderSummary): OrderSummary {
  return {
    ...first,
    ordered_at: first.ordered_at ?? second.ordered_at,
    total_price: first.total_price ?? second.total_price,
    status: first.status ?? second.status,
    item_names: unique([...first.item_names, ...second.item_names]),
  };
}

function itemScope($: CheerioAPI, main: Cheerio<Element>): Cheerio<Element> {
  const scope = main.find(DETAIL_SCOPE_SELECTOR).first();
  return scope.length > 0 ? scope : main;
}

function parseDetailItem($: CheerioAPI, card: Card, finalUrl: string): OrderItem {
  const name = detailItemName($, card, finalUrl);
  if (name === null) throw changed(`注文詳細ページで商品 ${card.id} の名前が見つかりません。`, finalUrl);
  const variationName = textOrNull(card.element.find(DETAIL_VARIATION_SELECTOR).first().text());
  return {
    item_id: card.id,
    name,
    variation_name: variationName,
    price: parseYenAmounts(textWithoutDownloads(card.element))[0] ?? null,
    downloadables: extractDownloadLinks($, card.element).map((link) => ({ ...link, variation_name: variationName })),
  };
}

function detailItemName($: CheerioAPI, card: Card, finalUrl: string): string | null {
  const anchors = [...card.element.find(DETAIL_NAME_SELECTOR).toArray(), ...card.element.find("a[href]").toArray()];
  for (const node of anchors) {
    const anchor = $(node);
    if (extractItemId(anchor.attr("href"), finalUrl) !== card.id) continue;
    const text = textOrNull(anchor.text());
    if (text !== null) return text;
  }
  return null;
}

function textWithoutDownloads(element: Cheerio<AnyNode>): string {
  const clone = element.clone();
  clone.find('a[href*="/downloadables/"], [data-href*="/downloadables/"]').remove();
  return clone.text();
}

function masked(value: string | null): string | null {
  return value === null ? null : redactSensitiveText(value).text;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
