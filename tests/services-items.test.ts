import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRawBoothItem } from "../src/booth/item-json.js";
import { ItemCache } from "../src/cache/item-cache.js";
import { BoothError } from "../src/errors.js";
import { BoothService } from "../src/service.js";
import { dictionaryError } from "../src/services/context.js";
import { searchHtml } from "./helpers/buyer-html.js";
import { itemJsonUrlOf, itemRoutes, publicItem, RoutedFakeReader } from "./helpers/fake-reader.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function setup(reader: RoutedFakeReader): Promise<{ service: BoothService; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "booth-library-mcp-items-"));
  tempPaths.push(home);
  return { service: new BoothService(reader, { env: { BOOTH_MCP_HOME: home } }), home };
}

async function cachedRecord(home: string, id: string): Promise<{ item: Record<string, unknown> }> {
  return JSON.parse(await readFile(join(home, "cache", "items", `${id}.json`), "utf8")) as { item: Record<string, unknown> };
}

describe("getItem", () => {
  it("returns the compact summary and stores the raw item in the cache", async () => {
    const reader = new RoutedFakeReader(itemRoutes([4866933]));
    const { service, home } = await setup(reader);
    const result = await service.getItem({ item: "https://booth.pm/ja/items/4866933" });
    expect(result.data).toMatchObject({ item_id: "4866933", shop: { name: "いな屋さん" }, category: { id: 209 } });
    expect(result.data.vrchat).toBeUndefined();
    expect(result.meta.sourceUrl).toBe(itemJsonUrlOf(4866933));
    expect((await cachedRecord(home, "4866933")).item.id).toBe(4866933);
  });

  it("adds VRChat info with evidence when include_vrchat is set", async () => {
    const { service } = await setup(new RoutedFakeReader(itemRoutes([4866933])));
    const { data } = await service.getItem({ item: 4866933, includeVrchat: true });
    expect(data.vrchat?.kind).toBe("costume");
    expect(data.vrchat?.compatible_avatars.map((avatar) => avatar.avatar)).toEqual(expect.arrayContaining(["shinano", "kikyo"]));
    expect(data.vrchat?.compatible_avatars.every((avatar) => avatar.evidence.length > 0)).toBe(true);
    expect(data.vrchat?.dependencies.map((dependency) => dependency.id)).toContain("liltoon");
    expect(data.vrchat).toHaveProperty("quest_support");
    expect(data.vrchat).not.toHaveProperty("owned_versions");
  });

  it("does not write logged-in viewer state into the cache", async () => {
    const raw = { ...(publicItem(6289322) as Record<string, unknown>), wished: true, order: { id: 1 }, gift: null };
    const { service, home } = await setup(new RoutedFakeReader({ [itemJsonUrlOf(6289322)]: { json: raw } }));
    const { data } = await service.getItem({ item: "6289322" });
    expect(data.viewer).toEqual({ wished: true, ordered: true, gifted: false, owned_variation_ids: [] });
    const cached = await cachedRecord(home, "6289322");
    expect(cached.item).toMatchObject({ wished: false, order: null, gift: null });
  });

  it("rejects non-BOOTH URLs before any request", async () => {
    const reader = new RoutedFakeReader();
    const { service } = await setup(reader);
    await expect(service.getItem({ item: "https://example.com/items/1" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(reader.calls).toEqual([]);
  });

  it("maps a 404 to NOT_FOUND", async () => {
    const reader = new RoutedFakeReader({ [itemJsonUrlOf(1)]: new BoothError("NOT_FOUND", "404") });
    const { service } = await setup(reader);
    await expect(service.getItem({ item: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports a broken avatars.json as INVALID_INPUT without the local path", async () => {
    const { service, home } = await setup(new RoutedFakeReader(itemRoutes([4866933])));
    await writeFile(join(home, "avatars.json"), "{ not json", "utf8");
    const error = await service.getItem({ item: 4866933, includeVrchat: true }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    expect((error as Error).message).not.toContain(home);
  });

  it("masks quoted and bare local paths in avatars.json errors", () => {
    const quoted = dictionaryError(new Error("EACCES: permission denied, open 'C:\\Users\\taro\\avatars.json'"));
    const bare = dictionaryError(new Error("cannot write /home/taro/.config/booth-library-mcp/avatars.json now"));
    const windows = dictionaryError(new Error("failed at C:\\Users\\taro\\AppData\\avatars.json"));
    for (const error of [quoted, bare, windows]) {
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).not.toContain("taro");
    }
  });
});

describe("searchItems / suggestTags", () => {
  it("returns one parsed search page with next_page", async () => {
    const url = "https://booth.pm/ja/search/%E3%81%97%E3%81%AA%E3%81%AE?page=2";
    const html = searchHtml([{ id: 101, name: "架空衣装A" }], { page: 2, lastPage: 9, total: 500 });
    const { service } = await setup(new RoutedFakeReader({ [url]: { html } }));
    const result = await service.searchItems({ query: "しなの", page: 2 });
    expect(result.data).toMatchObject({ page: 2, has_next: true, total_count: 500 });
    expect(result.data.items[0]).toMatchObject({ item_id: "101", name: "架空衣装A" });
    expect(result.meta).toMatchObject({ page: 2, nextPage: 3 });
  });

  it("does not offer a next page beyond page 5", async () => {
    const url = "https://booth.pm/ja/search/x?page=5";
    const html = searchHtml([{ id: 102, name: "X" }], { page: 5, lastPage: 9, total: 500 });
    const { service } = await setup(new RoutedFakeReader({ [url]: { html } }));
    const result = await service.searchItems({ query: "x", page: 5 });
    expect(result.meta.nextPage).toBeUndefined();
  });

  it("suggests tags", async () => {
    const url = `https://booth.pm/autocomplete/tag.json?term=${encodeURIComponent("しなの")}`;
    const { service } = await setup(new RoutedFakeReader({ [url]: { json: ["しなの", "しなの対応", "しなの"] } }));
    await expect(service.suggestTags(" しなの ")).resolves.toMatchObject({ data: { term: "しなの", tags: ["しなの", "しなの対応"] } });
  });
});

describe("checkCompatibility", () => {
  it("answers supported with evidence and serves the second call from the cache", async () => {
    const reader = new RoutedFakeReader(itemRoutes([4866933]));
    const { service } = await setup(reader);
    const first = await service.checkCompatibility({ item: 4866933, avatar: "シナノ" });
    expect(first.data).toMatchObject({ item_id: "4866933", avatar: "shinano", result: "supported", kind: "costume" });
    expect(first.data.evidence.length).toBeGreaterThan(0);
    expect(first.data.note).toContain("推測");
    await service.checkCompatibility({ item: "4866933", avatar: "kikyo" });
    expect(reader.count(itemJsonUrlOf(4866933))).toBe(1);
  });

  it("returns unknown (not supported) when there is no evidence", async () => {
    const { service } = await setup(new RoutedFakeReader(itemRoutes([6289322])));
    const { data } = await service.checkCompatibility({ item: 6289322, avatar: "桔梗" });
    expect(data.result).toBe("unknown");
  });

  it("rejects an empty avatar before any request", async () => {
    const reader = new RoutedFakeReader();
    const { service } = await setup(reader);
    await expect(service.checkCompatibility({ item: 1, avatar: "  " })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(reader.calls).toEqual([]);
  });
});

describe("searchForAvatar", () => {
  const ids = [6289322, 4866933, 3087170, 6659058, 8831909, 6106863, 3681787, 5359699, 4911160, 7065708, 4904935, 6745224];
  const searchUrl = `https://booth.pm/ja/browse/${encodeURIComponent("3D衣装")}?q=${encodeURIComponent("しなの")}`;

  it("searches with the avatar's primary name in the kind's category and scores only the first 10", async () => {
    const html = searchHtml(
      ids.map((id) => ({ id, name: `item ${id}` })),
      { page: 1, lastPage: 4, total: 200 },
    );
    const reader = new RoutedFakeReader({ [searchUrl]: { html }, ...itemRoutes(ids.slice(0, 10)) });
    const { service } = await setup(reader);
    const { data, meta } = await service.searchForAvatar({ avatar: "Shinano" });
    expect(data).toMatchObject({ avatar_id: "shinano", kind: "costume", category: "3D衣装", query: "しなの" });
    expect(data.results).toHaveLength(10);
    expect(data.unscored.map((item) => item.item_id)).toEqual(["4904935", "6745224"]);
    expect(data.results[0]?.compatibility.result).toBe("supported");
    const verdicts = data.results.map((hit) => hit.compatibility.result);
    expect(verdicts.indexOf("unknown")).toBeGreaterThan(verdicts.lastIndexOf("supported"));
    expect(reader.count("https://booth.pm/ja/items/")).toBe(10);
    expect(meta.nextPage).toBe(2);
  });

  it("puts results whose metadata failed into unscored and reports the error", async () => {
    const html = searchHtml([{ id: 6289322, name: "a" }, { id: 999, name: "gone" }], { page: 3, lastPage: 4, total: 2 });
    const url = `https://booth.pm/ja/browse/${encodeURIComponent("3D衣装")}?q=${encodeURIComponent("しなの")}+${encodeURIComponent("冬")}&page=3`;
    const reader = new RoutedFakeReader({
      [url]: { html },
      ...itemRoutes([6289322]),
      [itemJsonUrlOf(999)]: new BoothError("BOOTH_CHANGED", "x"),
    });
    const { service } = await setup(reader);
    const { data, meta } = await service.searchForAvatar({ avatar: "しなの", query: "冬", page: 3 });
    expect(data.results.map((hit) => hit.item_id)).toEqual(["6289322"]);
    expect(data.unscored.map((item) => item.item_id)).toEqual(["999"]);
    expect(data.errors).toEqual([{ item_id: "999", code: "BOOTH_CHANGED" }]);
    expect(meta.nextPage).toBeUndefined();
  });

  it("rejects pages beyond 3", async () => {
    const { service } = await setup(new RoutedFakeReader());
    await expect(service.searchForAvatar({ avatar: "しなの", page: 4 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Writes a cache record for a public fixture as if it had been fetched `ageMs` ago. */
async function seedCache(home: string, id: number, ageMs: number): Promise<string> {
  const fetchedAt = new Date(Date.now() - ageMs);
  const cache = new ItemCache({ dir: join(home, "cache", "items"), now: () => fetchedAt });
  return (await cache.set(id, parseRawBoothItem(publicItem(id)))).fetched_at;
}

describe("cache TTL setting (BOOTH_MCP_CACHE_TTL_DAYS)", () => {
  it("re-fetches cached items older than the configured number of days", async () => {
    const reader = new RoutedFakeReader(itemRoutes([4866933]));
    const { home } = await setup(reader);
    await seedCache(home, 4866933, 2 * DAY_MS);
    await new BoothService(reader, { env: { BOOTH_MCP_HOME: home } }).checkCompatibility({ item: 4866933, avatar: "しなの" });
    expect(reader.count(itemJsonUrlOf(4866933))).toBe(0);
    const shortTtl = new BoothService(reader, { env: { BOOTH_MCP_HOME: home, BOOTH_MCP_CACHE_TTL_DAYS: "1" } });
    await shortTtl.checkCompatibility({ item: 4866933, avatar: "しなの" });
    expect(reader.count(itemJsonUrlOf(4866933))).toBe(1);
  });

  it("warns once and keeps the 7-day default when the value is invalid", async () => {
    const reader = new RoutedFakeReader(itemRoutes([4866933]));
    const { home } = await setup(reader);
    await seedCache(home, 4866933, 2 * DAY_MS);
    const warnings: string[] = [];
    const service = new BoothService(reader, {
      env: { BOOTH_MCP_HOME: home, BOOTH_MCP_CACHE_TTL_DAYS: "0" },
      warn: (message) => warnings.push(message),
    });
    await service.checkCompatibility({ item: 4866933, avatar: "しなの" });
    expect(reader.count(itemJsonUrlOf(4866933))).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("BOOTH_MCP_CACHE_TTL_DAYS");
  });
});

describe("getItem stale fallback", () => {
  it.each(["RATE_LIMITED", "NETWORK_ERROR"] as const)("serves the cached copy marked stale on %s", async (code) => {
    const reader = new RoutedFakeReader({ [itemJsonUrlOf(4866933)]: new BoothError(code, "unavailable") });
    const { service, home } = await setup(reader);
    const fetchedAt = await seedCache(home, 4866933, 10 * DAY_MS);
    const result = await service.getItem({ item: 4866933, includeVrchat: true });
    expect(result.data).toMatchObject({ item_id: "4866933", stale: true, fetched_at: fetchedAt, vrchat: { kind: "costume" } });
    expect(reader.count(itemJsonUrlOf(4866933))).toBe(1);
  });

  it("does not mark a successful fetch as stale", async () => {
    const reader = new RoutedFakeReader(itemRoutes([4866933]));
    const { service, home } = await setup(reader);
    await seedCache(home, 4866933, 10 * DAY_MS);
    const { data } = await service.getItem({ item: 4866933 });
    expect(data.stale).toBeUndefined();
    expect(reader.count(itemJsonUrlOf(4866933))).toBe(1);
  });

  it("rethrows when nothing is cached", async () => {
    const { service } = await setup(new RoutedFakeReader({ [itemJsonUrlOf(4866933)]: new BoothError("RATE_LIMITED", "slow down") }));
    await expect(service.getItem({ item: 4866933 })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("does not hide NOT_FOUND behind a cached copy", async () => {
    const { service, home } = await setup(new RoutedFakeReader({ [itemJsonUrlOf(4866933)]: new BoothError("NOT_FOUND", "gone") }));
    await seedCache(home, 4866933, DAY_MS);
    await expect(service.getItem({ item: 4866933 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
