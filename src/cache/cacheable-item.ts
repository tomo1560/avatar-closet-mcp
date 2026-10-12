import type { RawBoothItem } from "../booth/item-json.js";

/** What a logged-out `items/{id}.json` request returns for a paid digital variation (tests/fixtures/public/items). */
const LOGGED_OUT_STATUS = "addable_to_cart";
/**
 * Logged in, a bought variation reads `already_bought_digital` instead of `addable_to_cart`. Verified 2026-10-12 on one
 * account: every such variation was paid and digital, with `downloadable: null`. The whole `already_bought` family is
 * treated as viewer state so a variant of it can never reach the cache either.
 */
const VIEWER_STATUS_PREFIX = "already_bought";

/**
 * Item JSON as a logged-out request would return it: viewer-specific (logged-in) fields are reset, so the cache only
 * holds public item data. Applied when writing a record and again when reading one, because cache files written
 * before this normalisation existed may still carry viewer state. Idempotent.
 */
export function toCacheableItem(raw: RawBoothItem): RawBoothItem {
  return {
    ...raw,
    wished: false,
    order: null,
    gift: null,
    ...("past_purchase_count" in raw ? { past_purchase_count: 0 } : {}),
    variations: raw.variations.map((variation) => ({
      ...variation,
      status: variation.status.startsWith(VIEWER_STATUS_PREFIX) ? LOGGED_OUT_STATUS : variation.status,
      ...("order_url" in variation ? { order_url: null } : {}),
      ...("past_purchase_count" in variation ? { past_purchase_count: 0 } : {}),
    })),
  };
}
