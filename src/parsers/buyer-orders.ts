/**
 * Parsers for accounts.booth.pm/orders and accounts.booth.pm/orders/{id} (the buyer's own orders).
 *
 * Verified against real page 2026-10-12 (/orders first page and one download-only /orders/{id}, logged in; see
 * tests/fixtures/buyer/orders.html and order-detail.html for the anonymized structure). The first structural sources
 * were OptoCloud/AssetDownloader (2024-07) BoothAccountOrdersScraper.cs / BoothAccountOrderScraper.cs and
 * Myrkie/BoothDownloader BoothPageParser.cs (September 2026). The parsers still key on links (order ids, item ids,
 * downloadable ids) and on label texts, and use classes only as preferred hints.
 * Also verified 2026-10-12 on all list pages of one account: a multi-item order is one /orders card per item (merged
 * here) and one sheet per item on /orders/{id}; a gift bought for someone else has a "ギフト" sheet, no file rows and a
 * private /gifts/{token}/edit link that is never returned (tests/fixtures/buyer/order-detail-multi.html, -gift.html).
 * Not seen with that account: physical goods (shipping block; every order whose items were missing from the library was
 * opened on 2026-10-12 and all were gifts or download orders, so the account has no physical order), the empty state,
 * and status / payment values other than the ones seen (発送完了, クレジットカード).
 *
 * Privacy: shipping/contact fields (name, address, phone, e-mail) are never selected. The two label fields that are
 * returned (status, payment method) are kept only when they are a known value of at most 60 characters (anything
 * else, e.g. a name, an address or injected instructions, becomes null), then passed through redactSensitiveText.
 */
import type { Cheerio, CheerioAPI } from "cheerio";
import { redactSensitiveText, restrictToVocabulary } from "../privacy.js";
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
  type IdExtractor,
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
// Verified against real page 2026-10-12: each order is one link, `.l-orders-index > a.nav-reverse[href="/orders/{id}"]`,
// wrapping a `div.sheet.sheet--p250` (OptoCloud BoothAccountOrdersScraper.cs had the sheet as the direct child).
const ORDER_CARD_SELECTOR = '.l-orders-index > a[href*="/orders/"]';
// Verified against real page 2026-10-12: one `div.u-tpg-caption1` item name per order card (OptoCloud
// BoothAccountOrdersScraper.cs). The list page shows no total, so OrderSummary.total_price is null there.
const ORDER_ITEM_NAME_SELECTOR = '[class*="u-tpg-caption1"]';
// Verified against real page 2026-10-12: `.badge.order-state.<state>` on both /orders cards and /orders/{id}.
const STATUS_SELECTOR = '.order-state, .badge, [class*="status"]';
/** Status badges appear only on order cards; seeing one without any order link means the markup changed. */
const ORDER_CONTENT_SIGNAL_SELECTOR = ".order-state";
// Verified against real page 2026-10-12: `.l-order-detail-by-shop` (first: shop header and item sheets; a second one
// holds the invoice form), item sheet `div.sheet.sheet--p400.mobile:pt-[13px]...` (Myrkie/BoothDownloader
// BoothPageParser.cs), name `div.text-14 > b > a.nav`. `u-tpg-title4` (OptoCloud, 2024) is kept as a fallback.
const DETAIL_SCOPE_SELECTOR = ".l-order-detail-by-shop";
const DETAIL_ITEM_SELECTOR = '[class*="sheet--p400"]';
const DETAIL_NAME_SELECTOR = '.text-14 b a[href], [class*="u-tpg-title4"] a[href]';
// TODO(PLAN §7-1): not backed by any source, and the real download-only order seen on 2026-10-12 shows no variation
// name at all (item name, price and a BOOST row only), so this is null in practice.
const DETAIL_VARIATION_SELECTOR = '[class*="variation"]';
/** Status and payment method are short labels; longer values are never returned. */
const MAX_LABEL_LENGTH = 60;
// Known values only (Japanese and English UI); extend this list when a real BOOTH label comes back as null. Matching is
// exact after NFKC, whitespace and case normalization. Seen on the real pages 2026-10-12: 発送完了 / クレジットカード.
const ORDER_STATUSES = [
  "支払待ち", "支払い待ち", "お支払い待ち", "入金待ち", "支払済み", "支払い済み", "お支払い済み", "支払済", "入金済み",
  "発送待ち", "発送準備中", "発送済み", "発送完了", "配送中", "キャンセル", "キャンセル済み", "返金済み",
  "ダウンロード可能", "完了", "取引完了", "支払期限切れ", "期限切れ",
  "Awaiting payment", "Waiting for payment", "Paid", "Payment completed", "Awaiting shipment", "Shipped",
  "Cancelled", "Canceled", "Refunded", "Downloadable", "Completed", "Expired",
] as const;
const PAYMENT_METHODS = [
  "クレジットカード", "クレジットカード決済", "クレジットカード払い", "PayPal", "PayPal決済", "楽天ペイ", "楽天ペイ決済",
  "コンビニ払い", "コンビニ決済", "銀行振込", "銀行振り込み", "銀行振込決済", "Amazon Pay", "d払い", "au PAY", "PayPay",
  "pixivコイン", "BOOTHポイント", "楽天ポイント", "Apple Pay", "Google Pay",
  "Credit card", "Convenience store", "Bank transfer",
] as const;
const TOTAL_LABELS = ["合計", "合計金額", "お支払い金額", "お支払金額", "支払金額", "total"];
// Label texts: OptoCloud BoothAccountOrderScraper.cs reads "order number" / "created at" (English UI). Verified against
// real page 2026-10-12 (Japanese UI): 注文日時 / 注文番号 / お支払方法 / お支払金額 in `.l-row` label/value columns.
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
  if (cards.length === 0 && hasOrderContent($, main, finalUrl)) {
    throw changed("注文履歴ページで注文は見つかりましたが注文番号のリンクが見つかりません。", finalUrl);
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
  const itemIdOf = (href: string | undefined): string | null => extractItemId(href, finalUrl);
  const scope = itemScope($, main, itemIdOf);
  const cards = findCards($, scope, itemIdOf, DETAIL_ITEM_SELECTOR);
  if (cards.length === 0) throw changed("注文詳細ページで商品が見つかりません。", finalUrl);
  const label = (labels: readonly string[]): string | null => findLabeledValue($, main, labels);
  const ordered = label(DETAIL_LABELS.orderedAt);
  const total = label(DETAIL_LABELS.total);
  const badge = textOrNull(main.find(STATUS_SELECTOR).first().text());
  return {
    order_id: orderId,
    ordered_at: ordered === null ? null : parseJstDateTime(ordered),
    status: knownLabel(badge, ORDER_STATUSES) ?? knownLabel(label(DETAIL_LABELS.status), ORDER_STATUSES),
    payment_method: knownLabel(label(DETAIL_LABELS.paymentMethod), PAYMENT_METHODS),
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
    status: knownLabel(textOrNull(card.element.find(STATUS_SELECTOR).first().text()), ORDER_STATUSES),
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

/** Every per-shop block that links to an item (the invoice block links to none); `main` when the class is gone. */
function itemScope($: CheerioAPI, main: Cheerio<Element>, itemIdOf: IdExtractor): Cheerio<Element> {
  const groups = main.find(DETAIL_SCOPE_SELECTOR).filter((_index, group) => idsWithin($, $(group), itemIdOf).size > 0);
  return groups.length > 0 ? groups : main;
}

function hasOrderContent($: CheerioAPI, main: Cheerio<Element>, finalUrl: string): boolean {
  return (
    main.find(ORDER_CONTENT_SIGNAL_SELECTOR).length > 0 ||
    idsWithin($, main, (href) => extractItemId(href, finalUrl)).size > 0
  );
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

/** A known label (see MAX_LABEL_LENGTH / ORDER_STATUSES / PAYMENT_METHODS) or null; redaction stays as a second layer. */
function knownLabel(value: string | null, vocabulary: readonly string[]): string | null {
  const known = restrictToVocabulary(value, vocabulary, MAX_LABEL_LENGTH);
  return known === null ? null : redactSensitiveText(known).text;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
