# Wish list and free downloads: captured shapes (2026-10-12)

Captured once each with the project's `BoothHttpClient` (GET, logged in, serial). All three returned HTTP 200 on the
requested URL with no redirect. Raw copies stay in the gitignored `tests/fixtures/private/`; the fixtures next to this
file are FICTIONAL and keep only the key names, key order, types and HTML skeleton.

## `GET https://accounts.booth.pm/wish_list_names.json` -> `wishlist-names.json`

Top level: array of lists (the fixture has 2). No pagination.

| key | type | notes |
|---|---|---|
| `code` | string | 8 chars, `[A-Z0-9]` (e.g. `K0FAKE01`); the `wish_list_name_code` filter value |
| `name` | string | user-chosen list name (private) |

## `GET https://accounts.booth.pm/wish_list_name_items.json?page=N` -> `wishlist-items.json`

Top level: object `{ items: Item[], pagination: Pagination }`. Sent with `Accept: application/json`; `readJson` with an
absolute `https://accounts.booth.pm/...` URL works (no CSRF token needed). Without `wish_list_name_code` it lists all
wished items, 20 per page.

`Item` (key order as returned):

| key | type | notes |
|---|---|---|
| `category` | object | `{ name: { en: string, ja: string }, url: string }`; url is `https://booth.pm/ja/browse/<encoded ja name>` |
| `event` | object \| null | `{ name: string, url: string }` (`https://booth.pm/ja/events/<slug>`) |
| `id` | number (integer) | item id |
| `is_adult` | boolean | |
| `is_end_of_sale` | boolean | |
| `is_placeholder` | boolean | |
| `is_sold_out` | boolean | |
| `is_vrchat` | boolean | |
| `minimum_stock` | null | always null in the capture |
| `music` | null | always null in the capture |
| `name` | string | item name |
| `price` | string | display string, e.g. `¥ 500`, `¥ 1,000`, `¥ 2,500~` (`~` = variations from this price) |
| `shop` | object | `{ thumbnail_url: string, name: string, url: string, verified: boolean }`; url is `https://<sub>.booth.pm/` |
| `thumbnail_image_urls` | string[] | one or more URLs on `booth.pximg.net` (`/c/300x300_a2_g5/.../i/<id>/..._base_resized.jpg`) |
| `url` | string | `https://booth.pm/ja/items/<id>` |
| `shop_item_url` | string | `<shop.url>items/<id>` |
| `wish_list_url` | string | `https://accounts.booth.pm/items/<id>/wish_list` |
| `tracking_data` | object | analytics copy: `{ product_id: number, product_name: string (name cut to 32 chars), product_price: number (yen, integer), product_brand: string (shop subdomain), product_category: number (category id, e.g. 209), product_event: string \| null (event slug), tracking: string ("impression_item") }` |

`Pagination` (Kaminari-style):

| key | type | notes |
|---|---|---|
| `current_page` | number | |
| `prev_page` | number \| null | null on page 1 |
| `next_page` | number \| null | number on page 1 of a multi-page list; null on the last page is assumed (not captured) |
| `limit_value` | number | 20 |
| `total_pages` | number | |
| `total_count` | number | |

## `GET https://accounts.booth.pm/library/free_downloads` -> `free-downloads.html`

HTTP 200, same layout as `/library` (title `ライブラリ - BOOTH`, `h1` ライブラリ, the three-tab
`nav.ui-segmented-tablet-nav` with `a.nav-item.current` on 無料ダウンロード). Cards are the same `div.bg-white.p-16`
with the item link, thumbnail (`img.l-library-item-thumbnail`), name (`.font-bold`) and shop link
(`.text-text-gray600`), 10 cards per page, but **no file rows**: the page has no `js-download-button` and no
`/downloadables/{id}` link. Kaminari pager (`div.pager`, `a.last-page` -> `?page=N`). `#js-library-search-data` has
`data-ga-from="library_free_downloads"`. See the comment at the top of `free-downloads.html`.

Not observed: an empty wish list or empty free-downloads page, and the last page of either.
