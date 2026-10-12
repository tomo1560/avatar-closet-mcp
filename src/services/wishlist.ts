import { ACCOUNTS_ORIGIN } from "../browser/url-policy.js";
import { parseWishlistItems, parseWishlistNames, type WishlistItem, type WishlistName } from "../parsers/wishlist.js";
import type { BoothResult, MetadataStatus, WishlistEntry, WishlistListing, WishlistNamesResult } from "../types.js";
import type { AvatarDictionary } from "../vrchat/types.js";
import { fetchMetadata, loadDictionary, type ServiceContext } from "./context.js";
import { LIST_MAX_FETCH, MAX_LIBRARY_PAGES, metadataStatus } from "./library.js";
import { invalidInput, wrap } from "./result.js";
import { buildVrchatInfo, HEURISTIC_NOTE } from "./vrchat-info.js";

export const WISHLIST_NAMES_URL = `${ACCOUNTS_ORIGIN}/wish_list_names.json`;
export const WISHLIST_ITEMS_URL = `${ACCOUNTS_ORIGIN}/wish_list_name_items.json`;
/** Highest `page` accepted (20 items per page on BOOTH). */
export const MAX_WISHLIST_PAGE = 50;
/** `all=true` reads at most this many pages (PLAN §2.4: no unbounded crawling). */
export const MAX_WISHLIST_WALK_PAGES = MAX_LIBRARY_PAGES;
const MAX_LIST_LENGTH = 100;
const MAX_LISTED_NAMES = 20;
const WISHLIST_HINT =
  "商品データ未取得の商品があります。同じ条件でもう一度呼ぶと続きを取得します（キャッシュ優先、1 回あたり最大 20 件）。";

export interface WishlistQuery {
  page?: number | undefined;
  /** Named list: its code (e.g. `K0FAKE01`) or its name. Omitted: every wished item. */
  list?: string | undefined;
  all?: boolean | undefined;
  includeVrchat?: boolean | undefined;
}

interface WishlistWalk {
  readonly items: readonly WishlistItem[];
  readonly lastPageRead: number;
  readonly totalPages: number;
  readonly totalCount: number;
  readonly hasNext: boolean;
  readonly truncated: boolean;
  readonly sourceUrl: string;
}

type WalkState = Omit<WishlistWalk, "items" | "truncated">;

/** The user's named wish lists (one request). */
export async function listWishlistNames(ctx: ServiceContext): Promise<BoothResult<WishlistNamesResult>> {
  const { data, url } = await ctx.reader.readJson(WISHLIST_NAMES_URL, parseWishlistNames);
  return wrap({ lists: data, count: data.length }, url);
}

/**
 * Wished items (every item, or one named list), one page or up to MAX_WISHLIST_WALK_PAGES with `all`.
 * `includeVrchat` adds the heuristic VRChat view from cache-first item metadata (at most 20 fetches per call).
 * Inputs are validated before any request.
 */
export async function listWishlist(ctx: ServiceContext, input: WishlistQuery = {}): Promise<BoothResult<WishlistListing>> {
  const startPage = validatePage(input.page);
  const listQuery = validateList(input.list);
  const dictionary = input.includeVrchat ? await loadDictionary(ctx) : undefined;
  const list = listQuery === undefined ? null : await resolveList(ctx, listQuery);
  const walk = await walkWishlist(ctx, list?.code, startPage, input.all ? MAX_WISHLIST_WALK_PAGES : 1);
  const enriched = dictionary ? await attachVrchat(ctx, walk.items, dictionary) : { entries: walk.items.map((item) => ({ ...item })) };
  const listing: WishlistListing = {
    list,
    items: enriched.entries,
    count: enriched.entries.length,
    first_page: startPage,
    last_page_read: walk.lastPageRead,
    total_pages: walk.totalPages,
    total_count: walk.totalCount,
    has_next: walk.hasNext,
    truncated: walk.truncated,
    ...("status" in enriched ? { ...enriched.status, note: HEURISTIC_NOTE } : {}),
  };
  return wrap(listing, walk.sourceUrl, { page: startPage, nextPage: walk.hasNext ? walk.lastPageRead + 1 : undefined });
}

/** Stops on the last page, when BOOTH answers another page than requested, or when a page brings no new ids. */
async function walkWishlist(ctx: ServiceContext, code: string | undefined, startPage: number, maxPages: number): Promise<WishlistWalk> {
  const byId = new Map<string, WishlistItem>();
  let state: WalkState = { lastPageRead: startPage, totalPages: 0, totalCount: 0, hasNext: false, sourceUrl: "" };
  for (let page = startPage; page < startPage + maxPages; page += 1) {
    const { data, url } = await ctx.reader.readJson(itemsUrl(code, page), parseWishlistItems);
    state = { ...state, totalPages: data.total_pages, totalCount: data.total_count, sourceUrl: state.sourceUrl || url };
    if (data.page !== page) {
      state = { ...state, hasNext: false };
      break;
    }
    const fresh = data.items.filter((item) => !byId.has(item.item_id));
    for (const item of fresh) byId.set(item.item_id, item);
    state = { ...state, lastPageRead: page, hasNext: page < data.total_pages && fresh.length > 0 };
    if (!state.hasNext) break;
  }
  const truncated = maxPages > 1 && state.hasNext && state.lastPageRead >= startPage + maxPages - 1;
  return { items: [...byId.values()], ...state, truncated };
}

function itemsUrl(code: string | undefined, page: number): string {
  const params = new URLSearchParams({ page: String(page) });
  if (code !== undefined) params.set("wish_list_name_code", code);
  return `${WISHLIST_ITEMS_URL}?${params.toString()}`;
}

/** Exact code, then exact name, then either one ignoring case. */
async function resolveList(ctx: ServiceContext, query: string): Promise<WishlistName> {
  const { data } = await ctx.reader.readJson(WISHLIST_NAMES_URL, parseWishlistNames);
  const folded = query.toLowerCase();
  const match =
    data.find((list) => list.code === query) ??
    data.find((list) => list.name === query) ??
    data.find((list) => list.code.toLowerCase() === folded || list.name.toLowerCase() === folded);
  if (match) return match;
  throw invalidInput(`ほしいものリスト「${query}」が見つかりません。${describeLists(data)}`);
}

function describeLists(lists: readonly WishlistName[]): string {
  if (lists.length === 0) return "名前付きのリストはありません（list を省略するとすべての商品を返します）。";
  const shown = lists.slice(0, MAX_LISTED_NAMES).map((list) => `${list.name} (${list.code})`);
  return `あるリスト: ${shown.join(", ")}${lists.length > MAX_LISTED_NAMES ? " ほか" : ""}`;
}

async function attachVrchat(
  ctx: ServiceContext,
  items: readonly WishlistItem[],
  dictionary: AvatarDictionary,
): Promise<{ entries: WishlistEntry[]; status: MetadataStatus }> {
  const batch = await fetchMetadata(
    ctx,
    items.map((item) => item.item_id),
    LIST_MAX_FETCH,
  );
  const entries = items.map((item) => {
    const raw = batch.items.get(item.item_id);
    return raw ? { ...item, vrchat: buildVrchatInfo(raw, dictionary) } : { ...item };
  });
  const status = metadataStatus(batch);
  // metadataStatus' hint points at the owned-item sync, which does not cover wished items.
  return { entries, status: status.metadata_pending > 0 ? { ...status, hint: WISHLIST_HINT } : status };
}

function validatePage(page: number | undefined): number {
  if (page === undefined) return 1;
  if (!Number.isInteger(page) || page < 1 || page > MAX_WISHLIST_PAGE) {
    throw invalidInput(`page は 1〜${MAX_WISHLIST_PAGE} の整数で指定してください。`);
  }
  return page;
}

function validateList(list: string | undefined): string | undefined {
  if (list === undefined) return undefined;
  const trimmed = list.trim();
  if (trimmed === "" || Array.from(trimmed).length > MAX_LIST_LENGTH) {
    throw invalidInput(`list にはリストのコードか名前を ${MAX_LIST_LENGTH} 文字以内で指定してください。`);
  }
  return trimmed;
}
