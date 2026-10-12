import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoothError } from "../src/errors.js";
import { BoothService } from "../src/service.js";
import { libraryHtml, type FakeLibraryItem } from "./helpers/buyer-html.js";
import { itemJsonUrlOf, itemRoutes, publicItem, RoutedFakeReader, type FakeRoute } from "./helpers/fake-reader.js";

const LIBRARY = "https://accounts.booth.pm/library";
const GIFTS = "https://accounts.booth.pm/library/gifts";
const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function serviceFor(reader: RoutedFakeReader): Promise<BoothService> {
  const home = await mkdtemp(join(tmpdir(), "booth-library-mcp-library-"));
  tempPaths.push(home);
  return new BoothService(reader, { env: { BOOTH_MCP_HOME: home } });
}

function pageUrl(base: string, page: number): string {
  return page > 1 ? `${base}?page=${page}` : base;
}

function libraryRoutes(pages: readonly (readonly FakeLibraryItem[])[], base = LIBRARY): Record<string, FakeRoute> {
  const path = new URL(base).pathname;
  return Object.fromEntries(
    pages.map((items, index) => [pageUrl(base, index + 1), { html: libraryHtml(items, { page: index + 1, lastPage: pages.length, path }) }]),
  );
}

function fakeItems(from: number, count: number): FakeLibraryItem[] {
  return Array.from({ length: count }, (_, index) => ({ id: from + index, name: `架空商品 ${from + index}` }));
}

/** A real public item JSON re-labelled with another id (so many distinct cached items can be served). */
function cloneItem(id: number, source = 6289322): FakeRoute {
  return { json: { ...(publicItem(source) as Record<string, unknown>), id } };
}

const OWNED: FakeLibraryItem[] = [
  { id: 4866933, name: "流行りのビキニ", shop: "いな屋さん", files: [{ id: 1, name: "Bikini_Shinano_v1.0.zip" }] },
  { id: 6106863, name: "オリジナル3Dモデル「しなの」", shop: "ポンデロニウム研究所" },
  { id: 3087170, name: "【無料】lilToon", shop: "lilLab" },
  { id: 6289322, name: "【しなの対応】Vigilant Style", shop: "Demicrown" },
  { id: 3681787, name: "オリジナル3Dモデル「桔梗」", shop: "ポンデロニウム研究所" },
];

describe("listLibrary paging", () => {
  it("reads one page and points to the next one", async () => {
    const reader = new RoutedFakeReader(libraryRoutes([fakeItems(100, 2), fakeItems(200, 2), fakeItems(300, 1)]));
    const service = await serviceFor(reader);
    const result = await service.listLibrary({ page: 2 });
    expect(reader.calls).toEqual([`${LIBRARY}?page=2`]);
    expect(result.data.items.map((item) => item.item_id)).toEqual(["200", "201"]);
    expect(result.data).toMatchObject({ source: "library", count: 2, has_next: true, last_page: 3, truncated: false });
    expect(result.meta).toMatchObject({ page: 2, nextPage: 3 });
  });

  it("walks every page with all=true and stops on the last page", async () => {
    const reader = new RoutedFakeReader(libraryRoutes([fakeItems(100, 2), fakeItems(200, 2), fakeItems(300, 1)]));
    const result = await (await serviceFor(reader)).listLibrary({ all: true });
    expect(reader.calls).toEqual([LIBRARY, `${LIBRARY}?page=2`, `${LIBRARY}?page=3`]);
    expect(result.data.count).toBe(5);
    expect(result.data).toMatchObject({ first_page: 1, last_page_read: 3, has_next: false, truncated: false });
    expect(result.meta.nextPage).toBeUndefined();
  });

  it("stops when BOOTH clamps a page past the end and re-serves the last page", async () => {
    const routes = libraryRoutes([fakeItems(100, 2), fakeItems(200, 2), fakeItems(300, 1)]);
    const page2 = routes[`${LIBRARY}?page=2`];
    const reader = new RoutedFakeReader({ ...routes, [`${LIBRARY}?page=3`]: page2 as FakeRoute });
    const result = await (await serviceFor(reader)).listLibrary({ all: true });
    expect(reader.calls).toHaveLength(3);
    expect(result.data.items.map((item) => item.item_id)).toEqual(["100", "101", "200", "201"]);
    expect(result.data).toMatchObject({ last_page_read: 2, has_next: false });
  });

  it("stops when a page brings no new item ids", async () => {
    const pages = [fakeItems(100, 2), fakeItems(100, 2), fakeItems(300, 1)];
    const reader = new RoutedFakeReader(libraryRoutes(pages));
    const result = await (await serviceFor(reader)).listLibrary({ all: true });
    expect(reader.calls).toEqual([LIBRARY, `${LIBRARY}?page=2`]);
    expect(result.data.count).toBe(2);
  });

  it("caps all=true at 20 pages and reports truncation", async () => {
    const pages = Array.from({ length: 25 }, (_, index) => fakeItems(1000 + index * 10, 1));
    const reader = new RoutedFakeReader(libraryRoutes(pages));
    const result = await (await serviceFor(reader)).listLibrary({ all: true });
    expect(reader.calls).toHaveLength(20);
    expect(result.data).toMatchObject({ truncated: true, has_next: true, last_page_read: 20 });
    expect(result.meta.nextPage).toBe(21);
  });

  it("returns an empty page when the requested page is past the end", async () => {
    const routes = libraryRoutes([fakeItems(100, 2)]);
    const reader = new RoutedFakeReader({ ...routes, [`${LIBRARY}?page=9`]: routes[LIBRARY] as FakeRoute });
    const result = await (await serviceFor(reader)).listLibrary({ page: 9 });
    expect(result.data).toMatchObject({ items: [], has_next: false });
  });

  it("reads gifts from /library/gifts", async () => {
    const reader = new RoutedFakeReader(libraryRoutes([fakeItems(500, 1)], GIFTS));
    const result = await (await serviceFor(reader)).listGifts();
    expect(reader.calls).toEqual([GIFTS]);
    expect(result.data).toMatchObject({ source: "gifts", count: 1 });
  });
});

describe("listFreeDownloads", () => {
  const FREE = "https://accounts.booth.pm/library/free_downloads";

  it("reads the free-downloads tab with the library inputs (cards without files)", async () => {
    const reader = new RoutedFakeReader(libraryRoutes([fakeItems(600, 1), fakeItems(700, 2)], FREE));
    const result = await (await serviceFor(reader)).listFreeDownloads({ page: 2 });
    expect(reader.calls).toEqual([`${FREE}?page=2`]);
    expect(result.data).toMatchObject({ source: "free_downloads", count: 2, last_page: 2, has_next: false });
    expect(result.data.items.every((item) => item.downloadables.length === 0)).toBe(true);
  });

  it("applies the local query filter and walks with all=true", async () => {
    const reader = new RoutedFakeReader(libraryRoutes([fakeItems(600, 1), [{ id: 701, name: "Free Shader" }]], FREE));
    const result = await (await serviceFor(reader)).listFreeDownloads({ all: true, query: "shader" });
    expect(reader.calls).toEqual([FREE, `${FREE}?page=2`]);
    expect(result.data.items.map((item) => item.item_id)).toEqual(["701"]);
  });
});

describe("listLibrary filters", () => {
  it("filters locally by name or shop, case-insensitively, without item requests", async () => {
    const reader = new RoutedFakeReader(libraryRoutes([OWNED]));
    const result = await (await serviceFor(reader)).listLibrary({ query: "LILLAB" });
    expect(result.data.items.map((item) => item.item_id)).toEqual(["3087170"]);
    expect(reader.calls).toEqual([LIBRARY]);
  });

  it("filters by avatar with evidence and owned versions from file names", async () => {
    const reader = new RoutedFakeReader({ ...libraryRoutes([OWNED]), ...itemRoutes(OWNED.map((item) => item.id)) });
    const { data } = await (await serviceFor(reader)).listLibrary({ avatar: "しなの" });
    expect(data.items.map((item) => item.item_id)).toEqual(["4866933", "6289322"]);
    const bikini = data.items[0];
    expect(bikini?.vrchat?.compatibility).toMatchObject({ avatar: "shinano", result: "supported" });
    expect(bikini?.vrchat?.owned_versions.map((version) => version.avatar)).toContain("shinano");
    expect(data).toMatchObject({ metadata_pending: 0, metadata_unavailable: 0, metadata_errors: [] });
    expect(data.hint).toBeUndefined();
  });

  it("filters by kind and by dependency", async () => {
    const reader = new RoutedFakeReader({ ...libraryRoutes([OWNED]), ...itemRoutes(OWNED.map((item) => item.id)) });
    const service = await serviceFor(reader);
    const avatars = await service.listLibrary({ kind: "avatar" });
    expect(avatars.data.items.map((item) => item.item_id)).toEqual(["6106863", "3681787"]);
    const liltoon = await service.listLibrary({ dependency: "lilToon" });
    expect(liltoon.data.items.map((item) => item.item_id)).toEqual(["4866933"]);
    expect(liltoon.data.filters).toEqual({ dependency: "liltoon" });
    expect(reader.count("https://booth.pm/ja/items/")).toBe(OWNED.length);
  });

  it("fetches at most 20 items per call and reports the rest as pending with a sync hint", async () => {
    const items = fakeItems(7000, 22);
    const routes = Object.fromEntries(items.map((item) => [itemJsonUrlOf(item.id), cloneItem(Number(item.id))]));
    const reader = new RoutedFakeReader({ ...libraryRoutes([items]), ...routes });
    const service = await serviceFor(reader);
    const first = await service.listLibrary({ avatar: "しなの" });
    expect(reader.count("https://booth.pm/ja/items/")).toBe(20);
    expect(first.data).toMatchObject({ count: 20, metadata_pending: 2 });
    expect(first.data.hint).toContain("booth_sync_library_metadata");
    const second = await service.listLibrary({ avatar: "しなの" });
    expect(reader.count("https://booth.pm/ja/items/")).toBe(22);
    expect(second.data).toMatchObject({ count: 22, metadata_pending: 0 });
  });

  it("remembers deleted items so later calls do not request them again", async () => {
    const owned = [...OWNED.slice(0, 1), { id: 999, name: "削除された商品" }];
    const reader = new RoutedFakeReader({
      ...libraryRoutes([owned]),
      ...itemRoutes([4866933]),
      [itemJsonUrlOf(999)]: new BoothError("NOT_FOUND", "404"),
    });
    const service = await serviceFor(reader);
    const first = await service.listLibrary({ kind: "costume" });
    expect(first.data).toMatchObject({ count: 1, metadata_unavailable: 1, metadata_errors: [] });
    await service.listLibrary({ kind: "costume" });
    expect(reader.count(itemJsonUrlOf(999))).toBe(1);
  });

  it("rejects an unknown dependency before any request", async () => {
    const reader = new RoutedFakeReader();
    const error = await (await serviceFor(reader)).listLibrary({ dependency: "nonexistent-tool" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect((error as Error).message).toContain("liltoon");
    expect(reader.calls).toEqual([]);
  });

  it("propagates AUTH_REQUIRED from the library page", async () => {
    const reader = new RoutedFakeReader({ [LIBRARY]: new BoothError("AUTH_REQUIRED", "login") });
    await expect((await serviceFor(reader)).listLibrary()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});

describe("orders", () => {
  const fixture = (name: string): string => readFileSync(new URL(`./fixtures/buyer/${name}`, import.meta.url), "utf8");

  it("lists one page of orders with next_page", async () => {
    const reader = new RoutedFakeReader({ "https://accounts.booth.pm/orders": { html: fixture("orders.html") } });
    const result = await (await serviceFor(reader)).listOrders();
    expect(result.data.orders.map((order) => order.order_id)).toEqual(["30000001", "30000002", "30000003"]);
    expect(result.meta).toMatchObject({ page: 1, nextPage: 2 });
  });

  it("returns an order without shipping or contact data", async () => {
    const url = "https://accounts.booth.pm/orders/30000001";
    const reader = new RoutedFakeReader({ [url]: { html: fixture("order-detail.html") } });
    const result = await (await serviceFor(reader)).getOrder(" 30000001 ");
    expect(Object.keys(result.data).sort()).toEqual(["items", "order_id", "ordered_at", "payment_method", "status", "total_price"]);
    const text = JSON.stringify(result);
    for (const secret of ["架空 太郎", "架空区", "123-4567", "000-0000-0000", "kakuu.taro@example.com"]) {
      expect(text).not.toContain(secret);
    }
    expect(result.data.items.length).toBeGreaterThan(0);
  });

  it("rejects a non-numeric order id before any request", async () => {
    const reader = new RoutedFakeReader();
    await expect((await serviceFor(reader)).getOrder("../settings")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(reader.calls).toEqual([]);
  });
});
