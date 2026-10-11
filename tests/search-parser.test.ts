import { readFileSync } from "node:fs";
import { load } from "cheerio";
import { describe, expect, it } from "vitest";
import { BoothError } from "../src/errors.js";
import { parseSearchPage } from "../src/parsers/search.js";

const SEARCH_URL = "https://booth.pm/ja/search/%E3%81%97%E3%81%AA%E3%81%AE%20%E8%A1%A3%E8%A3%85";
const realHtml = readFileSync(new URL("./fixtures/public/search.html", import.meta.url), "utf8");

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof BoothError) return error.code;
    throw error;
  }
  return undefined;
}

function edit(html: string, change: ($: ReturnType<typeof load>) => void): string {
  const $ = load(html);
  change($);
  return $.html();
}

function pagerHtml(current: number, last: number): string {
  const link = (page: number, body: string, extra = ""): string =>
    `<li${page === current && !extra ? ' class="current"' : ""}><a ${extra}class="nav-item${extra.includes("last") ? " last-page" : ""}" href="/ja/search/x?page=${page}">${body}</a></li>`;
  const pages = [current - 1, current, current + 1].filter((page) => page >= 1 && page <= last);
  const next = current < last ? `${link(current + 1, "&gt;", 'rel="next" ')}${link(last, "&raquo;", "last ")}` : "";
  return `<div class="pager"><nav><ul>${pages.map((page) => link(page, String(page))).join("")}${next}</ul></nav></div>`;
}

describe("parseSearchPage (real fixture: tests/fixtures/public/search.html)", () => {
  const result = parseSearchPage(realHtml, SEARCH_URL);

  it("returns all 60 cards of the page", () => {
    expect(result.items).toHaveLength(60);
    expect(new Set(result.items.map((item) => item.item_id)).size).toBe(60);
  });

  it("extracts the first card", () => {
    expect(result.items[0]).toEqual({
      item_id: "4409363",
      name: "タクティカルメイド (Tactical maid)",
      shop_name: "Ene Collection",
      shop_subdomain: "ene-0919",
      price: 1700,
      category_id: 209,
      thumbnail_url:
        "https://booth.pximg.net/c/300x300_a2_g5/70ebf4f0-7a56-45a6-bd50-359d32d604ed/i/4409363/c7e0ff28-c7d1-4d7c-9896-6a509a4c86ea_base_resized.jpg",
      url: "https://booth.pm/ja/items/4409363",
    });
  });

  it("uses the full title instead of the truncated data-product-name", () => {
    for (const item of result.items) {
      expect(item.name.endsWith("...")).toBe(false);
      expect(item.url).toBe(`https://booth.pm/ja/items/${item.item_id}`);
    }
  });

  it("returns numeric prices and categories for every card", () => {
    for (const item of result.items) {
      expect(Number.isInteger(item.price)).toBe(true);
      expect(Number.isInteger(item.category_id)).toBe(true);
      expect(item.shop_subdomain).toMatch(/^[\w-]+$/u);
    }
  });

  it("reads pagination and the total count", () => {
    expect(result).toMatchObject({ page: 1, last_page: 159, has_next: true, total_count: 9535 });
  });

  it("reads a middle page and the last page", () => {
    const middle = edit(realHtml, ($) => $(".pager").replaceWith(pagerHtml(80, 159)));
    expect(parseSearchPage(middle, `${SEARCH_URL}?page=80`)).toMatchObject({ page: 80, last_page: 159, has_next: true });
    const last = edit(realHtml, ($) => $(".pager").replaceWith(pagerHtml(159, 159)));
    expect(parseSearchPage(last, `${SEARCH_URL}?page=159`)).toMatchObject({ page: 159, last_page: 159, has_next: false });
  });

  it("treats a result list without a pager as a single page", () => {
    const single = edit(realHtml, ($) => $(".pager").remove());
    expect(parseSearchPage(single, SEARCH_URL)).toMatchObject({ page: 1, last_page: 1, has_next: false });
  });

  it("resolves relative item links against the final URL", () => {
    const relative = realHtml.replaceAll('href="https://booth.pm/ja/items/4409363"', 'href="/ja/items/4409363"');
    expect(parseSearchPage(relative, SEARCH_URL).items[0]?.url).toBe("https://booth.pm/ja/items/4409363");
  });

  it("returns an empty list for a search without results", () => {
    const empty = edit(realHtml, ($) => {
      $("li.item-card").remove();
      $(".pager").remove();
      $("b:contains('対象商品')").text("対象商品 0 件");
      $("p.u-tpg-caption1").first().text("しなの 衣装の通販・ダウンロード商品は0件あります。");
    });
    expect(parseSearchPage(empty, SEARCH_URL)).toEqual({
      items: [],
      page: 1,
      last_page: 1,
      has_next: false,
      total_count: 0,
    });
  });

  it("returns an empty list past the last page", () => {
    const past = edit(realHtml, ($) => {
      $("li.item-card").remove();
      $(".pager").remove();
    });
    expect(parseSearchPage(past, `${SEARCH_URL}?page=200`)).toMatchObject({ items: [], page: 200, has_next: false });
  });

  it("throws BOOTH_CHANGED when results exist but no card can be found", () => {
    const changed = realHtml.replaceAll('<li class="item-card', '<li class="product-tile');
    expect(codeOf(() => parseSearchPage(changed, SEARCH_URL))).toBe("BOOTH_CHANGED");
  });

  it("throws BOOTH_CHANGED when cards lose their id or title", () => {
    const noId = edit(realHtml, ($) => {
      $("li.item-card").removeAttr("data-product-id");
      $("li.item-card a[href]").removeAttr("href");
    });
    expect(codeOf(() => parseSearchPage(noId, SEARCH_URL))).toBe("BOOTH_CHANGED");
    const noTitle = edit(realHtml, ($) => {
      $(".item-card__title").remove();
      $("li.item-card").removeAttr("data-product-name");
    });
    expect(codeOf(() => parseSearchPage(noTitle, SEARCH_URL))).toBe("BOOTH_CHANGED");
  });

  it("throws AUTH_REQUIRED when redirected to the sign-in page", () => {
    const signIn = readFileSync(new URL("./fixtures/buyer/sign-in.html", import.meta.url), "utf8");
    expect(codeOf(() => parseSearchPage(signIn, "https://accounts.booth.pm/users/sign_in"))).toBe("AUTH_REQUIRED");
  });

  it("throws BOOTH_CHANGED for a page that is not a search result page", () => {
    expect(codeOf(() => parseSearchPage("<html><body><main><p>メンテナンス中</p></main></body></html>", SEARCH_URL))).toBe(
      "BOOTH_CHANGED",
    );
  });
});
