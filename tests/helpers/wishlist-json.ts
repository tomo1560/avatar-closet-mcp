/**
 * Builders for FICTIONAL wish-list JSON with the key layout of the real capture
 * (tests/fixtures/buyer/WISHLIST_CAPTURED.md, wishlist-items.json / wishlist-names.json).
 */

export const WISHLIST_NAMES = "https://accounts.booth.pm/wish_list_names.json";
export const WISHLIST_ITEMS = "https://accounts.booth.pm/wish_list_name_items.json";

export interface FakeWishlistItem {
  id: number;
  name: string;
  price?: string;
  shop?: string;
  isVrchat?: boolean;
  isSoldOut?: boolean;
  isAdult?: boolean;
}

export function wishlistItemsUrl(page: number, code?: string): string {
  return `${WISHLIST_ITEMS}?page=${page}${code === undefined ? "" : `&wish_list_name_code=${code}`}`;
}

export function wishlistItemsJson(
  items: readonly FakeWishlistItem[],
  pager: { page: number; totalPages: number; totalCount?: number },
): unknown {
  return {
    items: items.map(wishlistItemJson),
    pagination: {
      current_page: pager.page,
      prev_page: pager.page > 1 ? pager.page - 1 : null,
      next_page: pager.page < pager.totalPages ? pager.page + 1 : null,
      limit_value: 20,
      total_pages: pager.totalPages,
      total_count: pager.totalCount ?? items.length,
    },
  };
}

export function wishlistNamesJson(lists: ReadonlyArray<{ code: string; name: string }>): unknown {
  return lists.map((list) => ({ code: list.code, name: list.name }));
}

function wishlistItemJson(item: FakeWishlistItem): Record<string, unknown> {
  return {
    category: { name: { en: "3D Clothing", ja: "3D衣装" }, url: "https://booth.pm/ja/browse/3D%E8%A1%A3%E8%A3%85" },
    event: null,
    id: item.id,
    is_adult: item.isAdult ?? false,
    is_end_of_sale: false,
    is_placeholder: false,
    is_sold_out: item.isSoldOut ?? false,
    is_vrchat: item.isVrchat ?? true,
    minimum_stock: null,
    music: null,
    name: item.name,
    price: item.price ?? "¥ 1,000",
    shop: { thumbnail_url: "https://booth.pximg.net/c/48x48/users/1/icon.jpg", name: item.shop ?? "架空ショップ", url: "https://kakuu-shop.booth.pm/", verified: false },
    thumbnail_image_urls: [`https://booth.pximg.net/c/300x300_a2_g5/i/${item.id}/base_resized.jpg`],
    url: `https://booth.pm/ja/items/${item.id}`,
    shop_item_url: `https://kakuu-shop.booth.pm/items/${item.id}`,
    wish_list_url: `https://accounts.booth.pm/items/${item.id}/wish_list`,
    tracking_data: { product_id: item.id, product_name: item.name.slice(0, 32), product_price: 1000, product_brand: "kakuu-shop", product_category: 209, product_event: null, tracking: "impression_item" },
  };
}
