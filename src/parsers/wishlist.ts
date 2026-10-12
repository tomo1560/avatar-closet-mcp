/**
 * Parsers for the wish-list JSON behind accounts.booth.pm/wish_lists (the page itself is an empty JS mount point).
 *
 * Verified against a real logged-in capture 2026-10-12 (tests/fixtures/buyer/WISHLIST_CAPTURED.md, fictional copies in
 * wishlist-names.json / wishlist-items.json). The endpoints first came from wzken/booth-wishlist-bridge and
 * nfya-lab/booth-wishlist-sercher. Objects are loose (BOOTH may add keys); the fields used here are required, so a
 * missing or mistyped one is reported as BOOTH_CHANGED instead of silently becoming a default.
 */
import { z } from "zod";
import { isSignInUrl } from "../browser/url-policy.js";
import { BoothError } from "../errors.js";
import { ACCOUNTS_HOST, BOOTH_ORIGIN, isBoothHost, resolveUrl } from "./buyer-common.js";

/** One named wish list (`wish_list_name_code` filter value + the user's own label). */
export interface WishlistName {
  readonly code: string;
  readonly name: string;
}

export interface WishlistItem {
  readonly item_id: string;
  readonly name: string;
  readonly url: string;
  readonly shop_name: string | null;
  /** BOOTH's display string, e.g. `¥ 500` or `¥ 2,500~` (`~`: variations start at this price). */
  readonly price: string | null;
  /** Category name (Japanese when BOOTH sends both languages). */
  readonly category: string | null;
  readonly is_adult: boolean;
  readonly is_sold_out: boolean;
  readonly is_end_of_sale?: boolean;
  /** BOOTH's own VRChat flag (set by the seller); not the heuristic `vrchat` view. */
  readonly is_vrchat?: boolean;
}

export interface WishlistItemsPage {
  readonly items: readonly WishlistItem[];
  readonly page: number;
  readonly total_pages: number;
  readonly total_count: number;
}

const NAMES_PATH = /^\/wish_list_names\.json$/u;
const ITEMS_PATH = /^\/wish_list_name_items\.json$/u;
/** Captured codes are 8 characters of `[A-Z0-9]`; a little slack for future formats. */
const LIST_CODE = /^[A-Za-z0-9_-]{1,64}$/u;

const namesSchema = z.array(z.looseObject({ code: z.string().regex(LIST_CODE), name: z.string() }));

/** `{ en, ja }` in the capture; a plain string is accepted too (nfya-lab/booth-wishlist-sercher getCategoryName). */
const localizedNameSchema = z.union([z.string(), z.looseObject({ ja: z.string().optional(), en: z.string().optional() })]);

const itemSchema = z.looseObject({
  id: z.number().int().positive(),
  name: z.string(),
  url: z.string(),
  price: z.string().nullable(),
  is_adult: z.boolean(),
  is_sold_out: z.boolean(),
  is_end_of_sale: z.boolean().optional(),
  is_vrchat: z.boolean().optional(),
  shop: z.looseObject({ name: z.string() }).nullable(),
  category: z.looseObject({ name: localizedNameSchema }).nullable(),
});

const itemsPageSchema = z.looseObject({
  items: z.array(itemSchema),
  pagination: z.looseObject({
    current_page: z.number().int().min(1),
    total_pages: z.number().int().min(0),
    total_count: z.number().int().min(0),
  }),
});

type RawWishlistItem = z.infer<typeof itemSchema>;

/** `GET accounts.booth.pm/wish_list_names.json` → the user's named lists. */
export function parseWishlistNames(json: unknown, finalUrl: string): WishlistName[] {
  assertWishlistUrl(finalUrl, NAMES_PATH);
  const parsed = namesSchema.safeParse(json);
  if (!parsed.success) throw changedJson("ほしいものリスト名", finalUrl);
  return parsed.data.map((entry) => ({ code: entry.code, name: entry.name }));
}

/** `GET accounts.booth.pm/wish_list_name_items.json?page=N[&wish_list_name_code=CODE]` → one page of items. */
export function parseWishlistItems(json: unknown, finalUrl: string): WishlistItemsPage {
  assertWishlistUrl(finalUrl, ITEMS_PATH);
  const parsed = itemsPageSchema.safeParse(json);
  if (!parsed.success) throw changedJson("ほしいものリスト", finalUrl);
  const { items, pagination } = parsed.data;
  return {
    items: items.map(toWishlistItem),
    page: pagination.current_page,
    total_pages: pagination.total_pages,
    total_count: pagination.total_count,
  };
}

function toWishlistItem(raw: RawWishlistItem): WishlistItem {
  const itemId = String(raw.id);
  return {
    item_id: itemId,
    name: raw.name,
    url: itemUrl(raw.url, itemId),
    shop_name: raw.shop?.name ?? null,
    price: raw.price,
    category: categoryName(raw.category?.name),
    is_adult: raw.is_adult,
    is_sold_out: raw.is_sold_out,
    ...(raw.is_end_of_sale !== undefined ? { is_end_of_sale: raw.is_end_of_sale } : {}),
    ...(raw.is_vrchat !== undefined ? { is_vrchat: raw.is_vrchat } : {}),
  };
}

/** Only https URLs on BOOTH hosts are passed through; anything else falls back to the canonical item URL. */
function itemUrl(raw: string, itemId: string): string {
  const url = resolveUrl(raw, BOOTH_ORIGIN);
  return url && url.protocol === "https:" && isBoothHost(url.hostname) ? url.href : `${BOOTH_ORIGIN}/ja/items/${itemId}`;
}

function categoryName(name: z.infer<typeof localizedNameSchema> | undefined): string | null {
  if (name === undefined) return null;
  const text = typeof name === "string" ? name : (name.ja ?? name.en ?? "");
  return text.trim() === "" ? null : text.trim();
}

/** The reader follows only same-origin redirects; a sign-in URL or another path means no usable session / a change. */
function assertWishlistUrl(finalUrl: string, path: RegExp): void {
  if (isSignInUrl(finalUrl)) {
    throw new BoothError("AUTH_REQUIRED", "BOOTH にログインしていません。booth_login でログインしてください。", finalUrl);
  }
  const url = resolveUrl(finalUrl, BOOTH_ORIGIN);
  if (!url || url.hostname !== ACCOUNTS_HOST || !path.test(url.pathname)) {
    throw new BoothError("BOOTH_CHANGED", "ほしいものリストではない URL に到達しました。", finalUrl);
  }
}

function changedJson(label: string, finalUrl: string): BoothError {
  return new BoothError("BOOTH_CHANGED", `${label}の JSON 形式が想定と異なります（BOOTH の仕様変更の可能性があります）。`, finalUrl);
}
