import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BoothError } from "../src/errors.js";
import { parseWishlistItems, parseWishlistNames } from "../src/parsers/wishlist.js";
import { WISHLIST_NAMES, wishlistItemsJson, wishlistItemsUrl } from "./helpers/wishlist-json.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/buyer/${name}`, import.meta.url), "utf8")) as unknown;
}

const ITEMS_URL = wishlistItemsUrl(1);

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof BoothError) return error.code;
    throw error;
  }
  return undefined;
}

describe("parseWishlistNames (captured shape)", () => {
  it("returns code and name for every list", () => {
    expect(parseWishlistNames(fixture("wishlist-names.json"), WISHLIST_NAMES)).toEqual([
      { code: "K0FAKE01", name: "架空リスト" },
      { code: "K0FAKE02", name: "Fictional List" },
    ]);
  });

  it("accepts an empty array", () => {
    expect(parseWishlistNames([], WISHLIST_NAMES)).toEqual([]);
  });

  it.each([
    ["an object instead of an array", { wish_list_names: [] }],
    ["a list without a code", [{ name: "x" }]],
    ["a code that is not a plain token", [{ code: "a/b?c", name: "x" }]],
  ])("reports BOOTH_CHANGED for %s", (_label, json) => {
    expect(codeOf(() => parseWishlistNames(json, WISHLIST_NAMES))).toBe("BOOTH_CHANGED");
  });
});

describe("parseWishlistItems (captured shape)", () => {
  it("maps the captured item keys and the pagination", () => {
    const page = parseWishlistItems(fixture("wishlist-items.json"), ITEMS_URL);
    expect(page).toMatchObject({ page: 1, total_pages: 2, total_count: 23 });
    expect(page.items).toHaveLength(3);
    expect(page.items[0]).toEqual({
      item_id: "1000201",
      name: "架空ワンピース【しなの・桔梗・マヌカ対応】フルセット版",
      url: "https://booth.pm/ja/items/1000201",
      shop_name: "架空ショップ",
      price: "¥ 2,500~",
      category: "3D衣装",
      is_adult: false,
      is_sold_out: false,
      is_end_of_sale: false,
      is_vrchat: true,
    });
    expect(page.items.map((item) => [item.category, item.is_vrchat])).toEqual([
      ["3D衣装", true],
      ["3D装飾品", true],
      ["イラスト集", false],
    ]);
  });

  it("drops fields it does not use (tracking data, thumbnails, wish-list URLs)", () => {
    const [item] = parseWishlistItems(fixture("wishlist-items.json"), ITEMS_URL).items;
    expect(Object.keys(item ?? {})).not.toContain("tracking_data");
    expect(JSON.stringify(item)).not.toContain("wish_list");
  });

  it("accepts a plain-string category name and replaces a non-BOOTH item URL with the canonical one", () => {
    const json = wishlistItemsJson([{ id: 42, name: "架空" }], { page: 1, totalPages: 1 }) as {
      items: Array<Record<string, unknown>>;
    };
    const item = { ...json.items[0], category: { name: "3D小道具" }, url: "https://evil.example/items/42" };
    const [parsed] = parseWishlistItems({ ...json, items: [item] }, ITEMS_URL).items;
    expect(parsed).toMatchObject({ category: "3D小道具", url: "https://booth.pm/ja/items/42" });
  });

  it("accepts an empty list (total_pages 0)", () => {
    expect(parseWishlistItems(wishlistItemsJson([], { page: 1, totalPages: 0 }), ITEMS_URL)).toEqual({
      items: [],
      page: 1,
      total_pages: 0,
      total_count: 0,
    });
  });

  it.each([
    ["a missing pagination", { items: [] }],
    ["items that are not an array", { items: "x", pagination: { current_page: 1, total_pages: 1, total_count: 0 } }],
    ["an item without a name", { items: [{ id: 1 }], pagination: { current_page: 1, total_pages: 1, total_count: 1 } }],
    ["a non-object body", "<html>"],
  ])("reports BOOTH_CHANGED for %s", (_label, json) => {
    expect(codeOf(() => parseWishlistItems(json, ITEMS_URL))).toBe("BOOTH_CHANGED");
  });

  it("reports AUTH_REQUIRED when the request ended on a sign-in page", () => {
    expect(codeOf(() => parseWishlistItems({}, "https://accounts.booth.pm/users/sign_in"))).toBe("AUTH_REQUIRED");
  });

  it("reports BOOTH_CHANGED when the request ended on another page", () => {
    expect(codeOf(() => parseWishlistItems(fixture("wishlist-items.json"), "https://accounts.booth.pm/wish_lists"))).toBe("BOOTH_CHANGED");
  });
});
