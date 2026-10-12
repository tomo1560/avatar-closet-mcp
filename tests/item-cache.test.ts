import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRawBoothItem, type RawBoothItem } from "../src/booth/item-json.js";
import { summarizeItem } from "../src/booth/public.js";
import { toCacheableItem } from "../src/cache/cacheable-item.js";
import {
  DEFAULT_ITEM_CACHE_TTL_MS,
  ItemCache,
  MAX_CACHE_RECORD_BYTES,
  resolveCacheTtl,
  type CorruptCacheEntry,
  type ItemFetcher,
} from "../src/cache/item-cache.js";
import { BoothError, type BoothErrorCode } from "../src/errors.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const START = "2026-10-12T03:00:00Z";
const fixturePath = (id: string): string =>
  fileURLToPath(new URL(`./fixtures/public/items/${id}.json`, import.meta.url));
const baseItemJson = JSON.parse(readFileSync(fixturePath("6106863"), "utf8")) as Record<string, unknown>;

function makeItem(id: number | string): RawBoothItem {
  return parseRawBoothItem({ ...baseItemJson, id: Number(id), name: `item ${id}` });
}

let root: string;
let dir: string;
let clock: Date;
let corrupt: CorruptCacheEntry[];

function createCache(options: { ttlMs?: number } = {}): ItemCache {
  return new ItemCache({ dir, now: () => clock, onCorrupt: (entry) => corrupt.push(entry), ...options });
}

function advance(ms: number): void {
  clock = new Date(clock.getTime() + ms);
}

/** Fetcher that records calls, fails for ids in `failures`, and asserts it is never called concurrently. */
function fakeFetcher(failures: Record<string, BoothErrorCode | Error> = {}): { fetcher: ItemFetcher; calls: string[] } {
  const calls: string[] = [];
  let inFlight = 0;
  const fetcher: ItemFetcher = async (id) => {
    calls.push(id);
    inFlight += 1;
    expect(inFlight).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    const failure = failures[id];
    if (failure instanceof Error) throw failure;
    if (failure) throw new BoothError(failure, `${failure} for ${id}`);
    return makeItem(id);
  };
  return { fetcher, calls };
}

async function expectInvalidInput(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "BoothError", code: "INVALID_INPUT" });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "avatar-closet-mcp-item-cache-"));
  dir = join(root, "cache", "items");
  clock = new Date(START);
  corrupt = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveCacheTtl (BOOTH_MCP_CACHE_TTL_DAYS)", () => {
  it("defaults to 7 days without a warning when unset or empty", () => {
    expect(resolveCacheTtl({})).toEqual({ ttlMs: DEFAULT_ITEM_CACHE_TTL_MS, days: 7 });
    expect(resolveCacheTtl({ BOOTH_MCP_CACHE_TTL_DAYS: "  " })).toEqual({ ttlMs: DEFAULT_ITEM_CACHE_TTL_MS, days: 7 });
  });

  it.each([
    ["1", 1],
    [" 30 ", 30],
    ["0.5", 0.5],
    ["0.04", 0.04],
    ["365", 365],
  ])("accepts %s days", (value, days) => {
    expect(resolveCacheTtl({ BOOTH_MCP_CACHE_TTL_DAYS: value })).toEqual({ ttlMs: Math.round(days * DAY_MS), days });
  });

  it.each(["0", "0.01", "366", "-1", "abc", "Infinity", "7days"])("falls back to 7 days with a warning for %s", (value) => {
    const result = resolveCacheTtl({ BOOTH_MCP_CACHE_TTL_DAYS: value });
    expect(result).toMatchObject({ ttlMs: DEFAULT_ITEM_CACHE_TTL_MS, days: 7 });
    expect(result.warning).toContain("BOOTH_MCP_CACHE_TTL_DAYS");
    expect(result.warning).toContain("7 日");
  });
});

describe("ItemCache records", () => {
  it("writes the PLAN §3.5.7 record format and reads it back", async () => {
    const cache = createCache();
    const item = makeItem(6106863);
    const record = await cache.set("6106863", item);

    expect(record).toEqual({ item_id: 6106863, fetched_at: START, etag: null, item });
    const onDisk = JSON.parse(await readFile(join(dir, "6106863.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(onDisk)).toEqual(["item_id", "fetched_at", "etag", "item"]);
    expect(onDisk).toMatchObject({ item_id: 6106863, fetched_at: "2026-10-12T03:00:00Z", etag: null });
    expect(await cache.get(6106863)).toEqual(record);
    expect(corrupt).toEqual([]);
  });

  it("stores an etag when given", async () => {
    const cache = createCache();
    const record = await cache.set(1, makeItem(1), { etag: 'W/"abc"' });
    expect(record.etag).toBe('W/"abc"');
    expect((await cache.get(1))?.etag).toBe('W/"abc"');
  });

  it("returns null for missing records", async () => {
    const cache = createCache();
    expect(await cache.get(1)).toBeNull();
    expect(await cache.getStale(1)).toBeNull();
    expect(corrupt).toEqual([]);
  });

  it("expires records after the TTL (7 days by default) but keeps them for getStale", async () => {
    const cache = createCache();
    expect(cache.ttlMs).toBe(DEFAULT_ITEM_CACHE_TTL_MS);
    await cache.set(1, makeItem(1));

    advance(7 * DAY_MS - 1);
    expect(await cache.get(1)).not.toBeNull();
    advance(1);
    expect(await cache.get(1)).toBeNull();
    expect((await cache.getStale(1))?.fetched_at).toBe(START);
  });

  it("honours a custom TTL and distrusts timestamps from the future", async () => {
    const cache = createCache({ ttlMs: 1_000 });
    await cache.set(1, makeItem(1));
    advance(999);
    expect(await cache.get(1)).not.toBeNull();
    advance(1);
    expect(await cache.get(1)).toBeNull();

    clock = new Date(START);
    advance(-1);
    expect(await cache.get(1)).toBeNull();
  });

  it("rejects an invalid TTL", () => {
    expect(() => new ItemCache({ dir, ttlMs: -1 })).toThrow(BoothError);
    expect(() => new ItemCache({ dir, ttlMs: Number.NaN })).toThrow(BoothError);
  });

  it("defaults to {getCacheDir()}/items", () => {
    const previous = process.env.BOOTH_MCP_CACHE_DIR;
    process.env.BOOTH_MCP_CACHE_DIR = join(root, "env-cache");
    try {
      expect(new ItemCache().dir).toBe(join(root, "env-cache", "items"));
    } finally {
      if (previous === undefined) delete process.env.BOOTH_MCP_CACHE_DIR;
      else process.env.BOOTH_MCP_CACHE_DIR = previous;
    }
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["wrong record shape", JSON.stringify({ item_id: 5, fetched_at: "yesterday", etag: null, item: {} })],
    ["item failing the schema", JSON.stringify({ item_id: 5, fetched_at: START, etag: null, item: { id: 5 } })],
    ["item id mismatch", JSON.stringify({ item_id: 5, fetched_at: START, etag: null, item: makeItem(6) })],
    ["record id mismatch", JSON.stringify({ item_id: 6, fetched_at: START, etag: null, item: makeItem(5) })],
  ])("ignores and reports a corrupt file (%s)", async (_label, content) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "5.json"), content);
    const cache = createCache();
    expect(await cache.get(5)).toBeNull();
    expect(await cache.getStale(5)).toBeNull();
    expect(corrupt).toHaveLength(2);
    expect(corrupt[0]?.item_id).toBe("5");
    expect(corrupt[0]?.reason).toBeTruthy();
  });

  it("treats an unreadable path as corrupt instead of throwing", async () => {
    await mkdir(join(dir, "5.json"), { recursive: true });
    const cache = createCache();
    expect(await cache.get(5)).toBeNull();
    expect(corrupt[0]?.reason).toMatch(/^unreadable/);
  });

  it("treats a record file over 2 MiB as corrupt without parsing it", async () => {
    await mkdir(dir, { recursive: true });
    const record = { item_id: 5, fetched_at: START, etag: null, item: makeItem(5) };
    const padded = `${JSON.stringify(record)}${" ".repeat(MAX_CACHE_RECORD_BYTES)}`;
    await writeFile(join(dir, "5.json"), padded);
    const cache = createCache();
    expect(await cache.get(5)).toBeNull();
    expect(corrupt[0]).toEqual({ item_id: "5", reason: "too large" });

    await writeFile(join(dir, "5.json"), JSON.stringify(record));
    expect(await cache.get(5)).not.toBeNull();
  });

  it("works without an onCorrupt callback", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "5.json"), "{");
    expect(await new ItemCache({ dir }).get(5)).toBeNull();
  });

  it("refuses to cache an item under another id", async () => {
    await expectInvalidInput(createCache().set(2, makeItem(1)));
  });
});

describe("ItemCache viewer state", () => {
  const BOUGHT = "already_bought_digital";

  /** Item JSON as a logged-in buyer of its only (paid) variation receives it. */
  function boughtItemJson(id: number): Record<string, unknown> {
    const [variation] = baseItemJson.variations as Record<string, unknown>[];
    return { ...baseItemJson, id, wished: true, variations: [{ ...variation, status: BOUGHT, order_url: "https://example.invalid/o" }] };
  }

  function variationStatuses(item: RawBoothItem): string[] {
    return item.variations.map((variation) => variation.status);
  }

  it("maps the logged-in bought status to the logged-out one and leaves public statuses alone", () => {
    const free = { ...(baseItemJson.variations as Record<string, unknown>[])[0], id: 2, price: 0, status: "free_download" };
    const raw = parseRawBoothItem({ ...boughtItemJson(1), variations: [...(boughtItemJson(1).variations as unknown[]), free] });
    const snapshot = structuredClone(raw);
    const cacheable = toCacheableItem(raw);
    expect(variationStatuses(cacheable)).toEqual(["addable_to_cart", "free_download"]);
    expect(cacheable).toMatchObject({ wished: false, order: null, gift: null });
    expect(cacheable.variations[0]).toMatchObject({ order_url: null });
    expect(summarizeItem(cacheable).viewer).toBeNull();
    expect(toCacheableItem(cacheable)).toEqual(cacheable);
    expect(raw).toEqual(snapshot);
  });

  it("never writes the bought status to disk", async () => {
    const record = await createCache().set(1, parseRawBoothItem(boughtItemJson(1)));
    const onDisk = await readFile(join(dir, "1.json"), "utf8");
    expect(onDisk).not.toContain(BOUGHT);
    expect(variationStatuses(record.item)).toEqual(["addable_to_cart"]);
    expect(record.item.wished).toBe(false);
  });

  it("strips viewer state from records written before it was stripped on write", async () => {
    await mkdir(dir, { recursive: true });
    const legacy = { item_id: 1, fetched_at: START, etag: null, item: boughtItemJson(1) };
    await writeFile(join(dir, "1.json"), JSON.stringify(legacy));
    const cache = createCache();
    const { fetcher, calls } = fakeFetcher();
    const reads = [(await cache.get(1))?.item, (await cache.getStale(1))?.item, (await cache.fetchMany([1], fetcher)).items[0]?.item];
    expect(calls).toEqual([]);
    for (const item of reads) {
      expect(item && variationStatuses(item)).toEqual(["addable_to_cart"]);
      expect(item && summarizeItem(item).viewer).toBeNull();
    }
    expect(corrupt).toEqual([]);
  });

  it("returns freshly fetched items without viewer state", async () => {
    const fetcher: ItemFetcher = (id) => Promise.resolve(parseRawBoothItem(boughtItemJson(Number(id))));
    const { items } = await createCache().fetchMany([1], fetcher);
    expect(items[0] && variationStatuses(items[0].item)).toEqual(["addable_to_cart"]);
  });
});

describe("ItemCache files", () => {
  it("writes atomically and leaves no temporary files", async () => {
    const cache = createCache();
    await cache.set(1, makeItem(1));
    await cache.set(1, { ...makeItem(1), name: "updated" });
    expect(await readdir(dir)).toEqual(["1.json"]);
    expect((await cache.get(1))?.item.name).toBe("updated");
  });

  it("cleans up the temporary file when the rename fails", async () => {
    await mkdir(join(dir, "1.json", "blocker"), { recursive: true });
    const cache = createCache();
    await expect(cache.set(1, makeItem(1))).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["1.json"]);
  });

  // POSIX permission bits are not meaningful on Windows (ACLs instead).
  const posixIt = process.platform === "win32" ? it.skip : it;
  posixIt("creates files 0600 and directories 0700", async () => {
    await createCache().set(1, makeItem(1));
    expect((await stat(join(dir, "1.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("invalidates records", async () => {
    const cache = createCache();
    await cache.set(1, makeItem(1));
    expect(await cache.invalidate("1")).toBe(true);
    expect(await cache.invalidate("1")).toBe(false);
    expect(await cache.get(1)).toBeNull();
  });

  it("lists valid record ids in numeric order and ignores other files", async () => {
    const cache = createCache();
    expect(await cache.listIds()).toEqual([]);
    for (const id of [100, 9, 25]) await cache.set(id, makeItem(id));
    await writeFile(join(dir, "abc.json"), "{}");
    await writeFile(join(dir, "7.json.123.ab.tmp"), "{}");
    await writeFile(join(dir, "012.json"), "{}");
    expect(await cache.listIds()).toEqual(["9", "25", "100"]);
  });

  it("propagates unexpected errors from invalidate and listIds", async () => {
    await mkdir(join(dir, "1.json", "x"), { recursive: true });
    const cache = createCache();
    await expect(cache.invalidate(1)).rejects.toThrow();
    await writeFile(join(root, "not-a-dir"), "");
    await expect(new ItemCache({ dir: join(root, "not-a-dir") }).listIds()).rejects.toThrow();
  });

  it("validates ids before touching the file system (path traversal guard)", async () => {
    const cache = createCache();
    for (const bad of ["../../x", "..\\..\\x", "1/../2", "1.json", "", "0", "-1", "1e3"]) {
      await expectInvalidInput(cache.get(bad));
      await expectInvalidInput(cache.getStale(bad));
      await expectInvalidInput(cache.set(bad, makeItem(1)));
      await expectInvalidInput(cache.invalidate(bad));
    }
    const { fetcher, calls } = fakeFetcher();
    await expectInvalidInput(cache.fetchMany(["1", "../../x"], fetcher));
    await expectInvalidInput(cache.fetchMany(["1"], fetcher, { forceIds: ["../../x"] }));
    expect(calls).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });
});

describe("ItemCache.fetchMany", () => {
  it("serves fresh hits from cache and fetches misses sequentially, in input order", async () => {
    const cache = createCache();
    await cache.set(2, makeItem(2));
    const { fetcher, calls } = fakeFetcher();

    const result = await cache.fetchMany(["3", 2, "1", "3"], fetcher);

    expect(calls).toEqual(["3", "1"]);
    expect(result.fetched).toBe(2);
    expect(result.remaining).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.items.map(({ item_id, from_cache, stale }) => ({ item_id, from_cache, stale }))).toEqual([
      { item_id: "3", from_cache: false, stale: false },
      { item_id: "2", from_cache: true, stale: false },
      { item_id: "1", from_cache: false, stale: false },
    ]);
    expect(result.items[0]?.item.id).toBe(3);
    expect(result.items[0]?.fetched_at).toBe(START);
    expect(await cache.listIds()).toEqual(["1", "2", "3"]);
  });

  it("fetches at most maxFetch misses and returns the rest as remaining", async () => {
    const cache = createCache();
    const { fetcher, calls } = fakeFetcher();
    const result = await cache.fetchMany([1, 2, 3, 4, 5], fetcher, { maxFetch: 2 });
    expect(calls).toEqual(["1", "2"]);
    expect(result.fetched).toBe(2);
    expect(result.remaining).toEqual(["3", "4", "5"]);
    expect(result.items.map((entry) => entry.item_id)).toEqual(["1", "2"]);

    const next = await cache.fetchMany([1, 2, 3, 4, 5], fetcher, { maxFetch: 2 });
    expect(calls).toEqual(["1", "2", "3", "4"]);
    expect(next.remaining).toEqual(["5"]);
    expect(next.items).toHaveLength(4);
  });

  it("defaults to 20 fetches per call and supports cache-only mode", async () => {
    const cache = createCache();
    const ids = Array.from({ length: 25 }, (_, index) => index + 1);
    const { fetcher, calls } = fakeFetcher();
    const result = await cache.fetchMany(ids, fetcher);
    expect(calls).toHaveLength(20);
    expect(result.remaining).toEqual(["21", "22", "23", "24", "25"]);

    const cacheOnly = await cache.fetchMany(ids, fetcher, { maxFetch: 0 });
    expect(calls).toHaveLength(20);
    expect(cacheOnly.items).toHaveLength(20);
    expect(cacheOnly.remaining).toHaveLength(5);
  });

  it("continues past NOT_FOUND and other per-item errors", async () => {
    const cache = createCache();
    const { fetcher, calls } = fakeFetcher({ "2": "NOT_FOUND", "3": "BOOTH_CHANGED", "4": Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    const result = await cache.fetchMany([1, 2, 3, 4, 5], fetcher);
    expect(calls).toEqual(["1", "2", "3", "4", "5"]);
    expect(result.fetched).toBe(2);
    expect(result.remaining).toEqual([]);
    expect(result.items.map((entry) => entry.item_id)).toEqual(["1", "5"]);
    expect(result.errors.map(({ item_id, code }) => ({ item_id, code }))).toEqual([
      { item_id: "2", code: "NOT_FOUND" },
      { item_id: "3", code: "BOOTH_CHANGED" },
      { item_id: "4", code: "NETWORK_ERROR" },
    ]);
  });

  it.each(["RATE_LIMITED", "AUTH_REQUIRED"] as const)("stops early on %s", async (code) => {
    const cache = createCache();
    const { fetcher, calls } = fakeFetcher({ "2": code });
    const result = await cache.fetchMany([1, 2, 3, 4], fetcher);
    expect(calls).toEqual(["1", "2"]);
    expect(result.fetched).toBe(1);
    expect(result.remaining).toEqual(["2", "3", "4"]);
    expect(result.errors).toEqual([{ item_id: "2", code, message: `${code} for 2` }]);
  });

  it("re-fetches forceIds even when fresh", async () => {
    const cache = createCache();
    await cache.set(1, makeItem(1));
    await cache.set(2, makeItem(2));
    advance(DAY_MS);
    const { fetcher, calls } = fakeFetcher();
    const result = await cache.fetchMany([1, 2], fetcher, { forceIds: ["2", 99] });
    expect(calls).toEqual(["2"]);
    expect(result.items.map(({ item_id, from_cache }) => ({ item_id, from_cache }))).toEqual([
      { item_id: "1", from_cache: true },
      { item_id: "2", from_cache: false },
    ]);
    expect((await cache.get(2))?.fetched_at).toBe("2026-10-13T03:00:00Z");
  });

  it("serves stale records (flagged) when a refresh fails or is out of budget", async () => {
    const cache = createCache();
    await cache.set(1, makeItem(1));
    await cache.set(2, makeItem(2));
    advance(8 * DAY_MS);
    const { fetcher, calls } = fakeFetcher({ "1": "NOT_FOUND" });
    const result = await cache.fetchMany([1, 2], fetcher, { maxFetch: 1 });
    expect(calls).toEqual(["1"]);
    expect(result.remaining).toEqual(["2"]);
    expect(result.errors.map((error) => error.code)).toEqual(["NOT_FOUND"]);
    expect(result.items.map(({ item_id, from_cache, stale, fetched_at }) => ({ item_id, from_cache, stale, fetched_at }))).toEqual([
      { item_id: "1", from_cache: true, stale: true, fetched_at: START },
      { item_id: "2", from_cache: true, stale: true, fetched_at: START },
    ]);
  });

  it("re-fetches and overwrites corrupt records", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "1.json"), "garbage");
    const cache = createCache();
    const { fetcher, calls } = fakeFetcher();
    const result = await cache.fetchMany([1], fetcher);
    expect(calls).toEqual(["1"]);
    expect(corrupt.map((entry) => entry.item_id)).toEqual(["1"]);
    expect(result.items[0]?.from_cache).toBe(false);
    expect(await cache.get(1)).not.toBeNull();
  });

  it("reports BOOTH_CHANGED when the fetcher returns another item", async () => {
    const cache = createCache();
    const result = await cache.fetchMany([1, 2], (id) => Promise.resolve(makeItem(id === "1" ? 7 : 2)));
    expect(result.errors).toMatchObject([{ item_id: "1", code: "BOOTH_CHANGED" }]);
    expect(result.items.map((entry) => entry.item_id)).toEqual(["2"]);
    expect(await cache.listIds()).toEqual(["2"]);
  });

  it("still returns fetched items when the cache cannot be written, without leaking paths", async () => {
    await writeFile(join(root, "file"), "");
    const cache = new ItemCache({ dir: join(root, "file", "items"), now: () => clock });
    const { fetcher } = fakeFetcher();
    const result = await cache.fetchMany([1], fetcher);
    expect(result.fetched).toBe(1);
    expect(result.items).toMatchObject([{ item_id: "1", from_cache: false, stale: false, fetched_at: START }]);
    expect(result.errors).toMatchObject([{ item_id: "1", code: "CACHE_WRITE_FAILED" }]);
    expect(result.errors[0]?.message).not.toContain(root);
  });

  it("rejects an invalid maxFetch", async () => {
    const { fetcher } = fakeFetcher();
    await expectInvalidInput(createCache().fetchMany([1], fetcher, { maxFetch: -1 }));
    await expectInvalidInput(createCache().fetchMany([1], fetcher, { maxFetch: 1.5 }));
  });
});
