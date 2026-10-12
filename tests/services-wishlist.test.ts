import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoothError } from "../src/errors.js";
import { BoothService } from "../src/service.js";
import { WISHLIST_ITEMS_URL, WISHLIST_NAMES_URL } from "../src/services/wishlist.js";
import { itemJsonUrlOf, publicItem, RoutedFakeReader, type FakeRoute } from "./helpers/fake-reader.js";
import {
  WISHLIST_ITEMS,
  WISHLIST_NAMES,
  wishlistItemsJson,
  wishlistItemsUrl,
  wishlistNamesJson,
  type FakeWishlistItem,
} from "./helpers/wishlist-json.js";

const tempPaths: string[] = [];
const LISTS = [
  { code: "K0FAKE01", name: "衣装候補" },
  { code: "K0FAKE02", name: "Tools" },
];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function serviceFor(reader: RoutedFakeReader): Promise<BoothService> {
  const home = await mkdtemp(join(tmpdir(), "booth-library-mcp-wishlist-"));
  tempPaths.push(home);
  return new BoothService(reader, { env: { BOOTH_MCP_HOME: home } });
}

function fakeItems(from: number, count: number): FakeWishlistItem[] {
  return Array.from({ length: count }, (_, index) => ({ id: from + index, name: `架空商品 ${from + index}` }));
}

/** `pages[i]` is served as page i + 1 of `pages.length` (optionally of a named list). */
function itemRoutes(pages: readonly (readonly FakeWishlistItem[])[], code?: string): Record<string, FakeRoute> {
  const total = pages.reduce((sum, items) => sum + items.length, 0);
  return Object.fromEntries(
    pages.map((items, index) => [
      wishlistItemsUrl(index + 1, code),
      { json: wishlistItemsJson(items, { page: index + 1, totalPages: pages.length, totalCount: total }) },
    ]),
  );
}

describe("listWishlist", () => {
  it("reads one page of every wished item and points to the next one", async () => {
    const reader = new RoutedFakeReader(itemRoutes([fakeItems(100, 2), fakeItems(200, 1)]));
    const result = await (await serviceFor(reader)).listWishlist();
    expect(reader.calls).toEqual([wishlistItemsUrl(1)]);
    expect(result.data).toMatchObject({
      list: null,
      count: 2,
      first_page: 1,
      last_page_read: 1,
      total_pages: 2,
      total_count: 3,
      has_next: true,
      truncated: false,
    });
    expect(result.data.items[0]).toMatchObject({ item_id: "100", price: "¥ 1,000", category: "3D衣装", is_vrchat: true });
    expect(result.data.items[0]?.vrchat).toBeUndefined();
    expect(result.data.metadata_pending).toBeUndefined();
    expect(result.meta).toMatchObject({ sourceUrl: wishlistItemsUrl(1), page: 1, nextPage: 2 });
  });

  it("walks every page with all=true", async () => {
    const reader = new RoutedFakeReader(itemRoutes([fakeItems(100, 2), fakeItems(200, 2), fakeItems(300, 1)]));
    const result = await (await serviceFor(reader)).listWishlist({ all: true, page: 2 });
    expect(reader.calls).toEqual([wishlistItemsUrl(2), wishlistItemsUrl(3)]);
    expect(result.data).toMatchObject({ count: 3, first_page: 2, last_page_read: 3, has_next: false, truncated: false });
    expect(result.meta.nextPage).toBeUndefined();
  });

  it("stops all=true at 20 pages and reports truncated", async () => {
    const pages = Array.from({ length: 25 }, (_, index) => fakeItems(1000 + index * 10, 1));
    const reader = new RoutedFakeReader(itemRoutes(pages));
    const result = await (await serviceFor(reader)).listWishlist({ all: true });
    expect(reader.calls).toHaveLength(20);
    expect(result.data).toMatchObject({ count: 20, last_page_read: 20, has_next: true, truncated: true });
    expect(result.meta.nextPage).toBe(21);
  });

  it("stops when BOOTH answers another page than the requested one", async () => {
    const routes = itemRoutes([fakeItems(100, 1), fakeItems(200, 1), fakeItems(300, 1)]);
    const reader = new RoutedFakeReader({ ...routes, [wishlistItemsUrl(3)]: routes[wishlistItemsUrl(2)] as FakeRoute });
    const result = await (await serviceFor(reader)).listWishlist({ all: true });
    expect(result.data.items.map((item) => item.item_id)).toEqual(["100", "200"]);
    expect(result.data).toMatchObject({ last_page_read: 2, has_next: false });
  });

  it("returns an empty page past the end without a next page", async () => {
    const reader = new RoutedFakeReader({ [wishlistItemsUrl(9)]: { json: wishlistItemsJson([], { page: 9, totalPages: 2, totalCount: 30 }) } });
    const result = await (await serviceFor(reader)).listWishlist({ page: 9 });
    expect(result.data).toMatchObject({ count: 0, has_next: false, total_count: 30 });
  });

  it.each([
    ["the list name", "衣装候補"],
    ["the list code", "K0FAKE01"],
    ["the code in lower case", "k0fake01"],
  ])("filters by a named list given by %s", async (_label, list) => {
    const reader = new RoutedFakeReader({
      [WISHLIST_NAMES]: { json: wishlistNamesJson(LISTS) },
      ...itemRoutes([fakeItems(500, 2)], "K0FAKE01"),
    });
    const result = await (await serviceFor(reader)).listWishlist({ list });
    expect(reader.calls).toEqual([WISHLIST_NAMES, wishlistItemsUrl(1, "K0FAKE01")]);
    expect(result.data.list).toEqual({ code: "K0FAKE01", name: "衣装候補" });
    expect(result.data.count).toBe(2);
  });

  it("rejects an unknown list with the available ones and reads no items", async () => {
    const reader = new RoutedFakeReader({ [WISHLIST_NAMES]: { json: wishlistNamesJson(LISTS) } });
    const error = await (await serviceFor(reader)).listWishlist({ list: "存在しない" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect((error as Error).message).toContain("衣装候補 (K0FAKE01)");
    expect(reader.calls).toEqual([WISHLIST_NAMES]);
  });

  it.each([
    [{ page: 0 }],
    [{ page: 51 }],
    [{ page: 1.5 }],
    [{ list: "   " }],
    [{ list: "x".repeat(101) }],
  ])("rejects %j before any request", async (input) => {
    const reader = new RoutedFakeReader();
    await expect((await serviceFor(reader)).listWishlist(input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(reader.calls).toEqual([]);
  });

  it("passes AUTH_REQUIRED through (no session or a sign-in redirect)", async () => {
    const reader = new RoutedFakeReader({ [wishlistItemsUrl(1)]: new BoothError("AUTH_REQUIRED", "ログインが必要です。") });
    await expect((await serviceFor(reader)).listWishlist()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("reports BOOTH_CHANGED when the JSON no longer matches", async () => {
    const reader = new RoutedFakeReader({ [wishlistItemsUrl(1)]: { json: { items: "changed" } } });
    await expect((await serviceFor(reader)).listWishlist()).rejects.toMatchObject({ code: "BOOTH_CHANGED" });
  });
});

describe("listWishlist include_vrchat", () => {
  it("adds the heuristic VRChat view from cache-first item metadata", async () => {
    const reader = new RoutedFakeReader({
      ...itemRoutes([[{ id: 6289322, name: "【しなの対応】Vigilant Style" }]]),
      [itemJsonUrlOf(6289322)]: { json: publicItem(6289322) },
    });
    const service = await serviceFor(reader);
    const first = await service.listWishlist({ includeVrchat: true });
    expect(first.data.items[0]?.vrchat?.kind).toBe("costume");
    expect(first.data.items[0]?.vrchat?.compatible_avatars.map((avatar) => avatar.avatar)).toContain("shinano");
    expect(first.data).toMatchObject({ metadata_pending: 0, metadata_unavailable: 0, metadata_errors: [] });
    expect(first.data.note).toContain("ヒューリスティック");
    await service.listWishlist({ includeVrchat: true });
    expect(reader.count(itemJsonUrlOf(6289322))).toBe(1);
  });

  it("fetches at most 20 items per call and reports the rest as pending", async () => {
    const items = fakeItems(7000, 23);
    const source = publicItem(6289322) as Record<string, unknown>;
    const metadata = Object.fromEntries(items.map((item) => [itemJsonUrlOf(item.id), { json: { ...source, id: item.id } }]));
    const reader = new RoutedFakeReader({ ...itemRoutes([items]), ...metadata });
    const result = await (await serviceFor(reader)).listWishlist({ includeVrchat: true });
    expect(reader.count("https://booth.pm/ja/items/")).toBe(20);
    expect(result.data.metadata_pending).toBe(3);
    expect(result.data.items.filter((item) => item.vrchat !== undefined)).toHaveLength(20);
    expect(result.data.hint).toContain("もう一度");
    expect(result.data.hint).not.toContain("sync");
  });
});

describe("listWishlistNames", () => {
  it("returns the named lists in one request", async () => {
    const reader = new RoutedFakeReader({ [WISHLIST_NAMES]: { json: wishlistNamesJson(LISTS) } });
    const result = await (await serviceFor(reader)).listWishlistNames();
    expect(result.data).toEqual({ lists: LISTS, count: 2 });
    expect(result.meta.sourceUrl).toBe(WISHLIST_NAMES);
    expect(reader.calls).toEqual([WISHLIST_NAMES]);
  });

  it("passes AUTH_REQUIRED through", async () => {
    const reader = new RoutedFakeReader({ [WISHLIST_NAMES]: new BoothError("AUTH_REQUIRED", "ログインが必要です。") });
    await expect((await serviceFor(reader)).listWishlistNames()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});

describe("wish-list URLs", () => {
  it("only targets the accounts.booth.pm JSON endpoints", () => {
    expect(WISHLIST_NAMES_URL).toBe(WISHLIST_NAMES);
    expect(WISHLIST_ITEMS_URL).toBe(WISHLIST_ITEMS);
    expect(new URL(WISHLIST_ITEMS_URL).origin).toBe("https://accounts.booth.pm");
  });
});
