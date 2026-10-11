/**
 * Builders for FICTIONAL accounts.booth.pm library pages and booth.pm search pages, using the same markup
 * as tests/fixtures/buyer/library.html and tests/fixtures/public/search.html.
 */

export interface FakeLibraryItem {
  id: string | number;
  name: string;
  shop?: string;
  files?: ReadonlyArray<{ id: string | number; name: string }>;
}

export interface FakePager {
  page: number;
  lastPage: number;
  /** `/library` or `/library/gifts`. */
  path?: string;
}

export function libraryHtml(items: readonly FakeLibraryItem[], pager: FakePager): string {
  const path = pager.path ?? "/library";
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>ライブラリ - BOOTH</title></head><body>
<main role="main"><div class="flex gap-40 mx-auto desktop:w-fit"><div class="w-full desktop:w-[808px] mb-24 flex flex-col gap-16">
${items.map(libraryCard).join("\n")}
${pagerHtml(path, pager.page, pager.lastPage)}
</div></div></main></body></html>`;
}

function libraryCard(item: FakeLibraryItem): string {
  const shop = item.shop ?? "架空ショップ";
  const files = (item.files ?? [])
    .map(
      (file) => `<div class="mt-16 desktop:flex desktop:justify-between desktop:items-center">
<div class="min-w-0 break-words whitespace-pre-line"><div class="text-14">${file.name}</div></div>
<div class="mt-8 desktop:mt-0 shrink-0 flex items-center gap-8"><div></div>
<div><div class="js-download-button" data-href="https://booth.pm/downloadables/${file.id}" data-is-external="false" data-label="ダウンロード" data-test="downloadable"></div></div></div></div>`,
    )
    .join("\n");
  return `<div class="bg-white p-16 desktop:rounded-8 desktop:py-24 desktop:px-40"><div class="flex gap-8 desktop:gap-16 border-b border-border300 pb-16">
<a target="_blank" rel="noopener" href="https://booth.pm/ja/items/${item.id}"><img class="l-library-item-thumbnail" src="https://booth.pximg.net/c/300x300_a2_g5/${item.id}.jpg" width="80" height="80"></a>
<div><a class="no-underline" target="_blank" rel="noopener" href="https://booth.pm/ja/items/${item.id}"><div class="text-text-default font-bold text-16 mb-8 break-all">${item.name}</div></a>
<a class="no-underline w-fit flex gap-4 items-center" target="_blank" rel="noopener" href="https://kakuu-shop.booth.pm/"><div class="text-14 text-text-gray600 break-all">${shop}</div></a></div></div>
<div class="mt-16">${files}</div></div>`;
}

function pagerHtml(path: string, page: number, lastPage: number): string {
  const href = (n: number): string => (n === 1 ? path : `${path}?page=${n}`);
  const numbers = Array.from({ length: lastPage }, (_, index) => index + 1)
    .map((n) => `<li${n === page ? ' class="current"' : ""}><a class="nav-item" href="${href(n)}">${n}</a></li>`)
    .join("");
  const next = page < lastPage ? `<li><a rel="next" class="nav-item" href="${href(page + 1)}">›</a></li>` : "";
  const last = page < lastPage ? `<li><a class="nav-item last-page" href="${href(lastPage)}">»</a></li>` : "";
  return `<div class="pager"><nav><ul>${numbers}${next}${last}</ul></nav></div>`;
}

export interface FakeSearchItem {
  id: string | number;
  name: string;
  category?: number;
  price?: number;
}

export function searchHtml(items: readonly FakeSearchItem[], pager: { page: number; lastPage: number; total: number }): string {
  const cards = items
    .map(
      (item) => `<li class="item-card" data-product-id="${item.id}" data-product-name="${item.name}" data-product-brand="kakuu-shop"
 data-product-category="${item.category ?? 209}" data-product-price="${item.price ?? 1000}">
<div class="item-card__title"><a class="item-card__title-anchor--multiline" href="https://booth.pm/ja/items/${item.id}">${item.name}</a></div>
<div class="item-card__shop-name">架空ショップ</div></li>`,
    )
    .join("\n");
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"></head><body>
<p class="u-tpg-caption1">検索の通販・ダウンロード商品は${pager.total}件あります。</p>
<div class="l-market-grid"><ul>${cards}</ul></div>
${pagerHtml("/ja/search/q", pager.page, pager.lastPage)}
</body></html>`;
}
