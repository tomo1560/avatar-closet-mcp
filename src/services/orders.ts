import { ACCOUNTS_ORIGIN } from "../browser/url-policy.js";
import { parseOrderDetail, parseOrdersPage, type OrderDetail } from "../parsers/buyer-orders.js";
import { redactionsIn } from "../privacy.js";
import type { BoothResult, OrderResult, OrdersListing } from "../types.js";
import type { ServiceContext } from "./context.js";
import { assertNumericId, invalidInput, pagedUrl, wrap } from "./result.js";

const ORDERS_URL = `${ACCOUNTS_ORIGIN}/orders`;

/** One page of the buyer's order history. Free-text fields are masked by the parser. */
export async function listOrders(ctx: ServiceContext, page = 1): Promise<BoothResult<OrdersListing>> {
  if (!Number.isInteger(page) || page < 1) throw invalidInput("page は 1 以上の整数で指定してください。");
  const { data, url } = await ctx.reader.read(pagedUrl(ORDERS_URL, page), parseOrdersPage);
  // Real BOOTH answers an out-of-range page with an empty list (not the last page). Defensive only: never report the
  // orders of another page than the requested one.
  const clamped = data.page !== page;
  const listing: OrdersListing = {
    orders: clamped ? [] : data.orders,
    page,
    last_page: data.last_page,
    has_next: !clamped && data.has_next,
  };
  const redactions = redactionsIn(listing.orders.map((order) => order.status));
  return wrap(listing, url, { page, nextPage: listing.has_next ? page + 1 : undefined, redactions });
}

/**
 * One order: items, prices and downloadable ids. The parser never selects shipping / contact fields
 * (name, address, phone, e-mail); the result is rebuilt from an allowlist of fields as a second guard.
 */
export async function getOrder(ctx: ServiceContext, orderId: string): Promise<BoothResult<OrderResult>> {
  const id = orderId.trim();
  assertNumericId(id, "注文");
  const { data, url } = await ctx.reader.read(`${ORDERS_URL}/${id}`, parseOrderDetail);
  const order = allowlistedOrder(data);
  return wrap(order, url, { redactions: redactionsIn([order.status, order.payment_method]) });
}

function allowlistedOrder(order: OrderDetail): OrderDetail {
  return {
    order_id: order.order_id,
    ordered_at: order.ordered_at,
    status: order.status,
    payment_method: order.payment_method,
    total_price: order.total_price,
    items: order.items.map((item) => ({
      item_id: item.item_id,
      name: item.name,
      variation_name: item.variation_name,
      price: item.price,
      downloadables: item.downloadables.map((file) => ({
        downloadable_id: file.downloadable_id,
        file_name: file.file_name,
        variation_name: file.variation_name,
      })),
    })),
  };
}
