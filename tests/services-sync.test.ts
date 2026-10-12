import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoothError } from "../src/errors.js";
import { BoothService } from "../src/service.js";
import { CACHE_SNAPSHOT_FILE_NAME } from "../src/library/update-snapshot.js";
import { Memo } from "../src/services/context.js";
import { libraryHtml, type FakeLibraryItem } from "./helpers/buyer-html.js";
import { itemJsonUrlOf, itemRoutes, publicItem, RoutedFakeReader, type FakeRoute } from "./helpers/fake-reader.js";

const LIBRARY = "https://accounts.booth.pm/library";
const GIFTS = "https://accounts.booth.pm/library/gifts";
const FREE = "https://accounts.booth.pm/library/free_downloads";
const ITEMS = "https://booth.pm/ja/items/";
const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function setup(reader: RoutedFakeReader): Promise<{ service: BoothService; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "avatar-closet-mcp-sync-"));
  tempPaths.push(home);
  return { service: new BoothService(reader, { env: { BOOTH_MCP_HOME: home } }), home };
}

function ownedRoutes(
  library: readonly FakeLibraryItem[],
  gifts: readonly FakeLibraryItem[] = [],
  free: readonly FakeLibraryItem[] = [],
): Record<string, FakeRoute> {
  return {
    [LIBRARY]: { html: libraryHtml(library, { page: 1, lastPage: 1 }) },
    [GIFTS]: { html: libraryHtml(gifts, { page: 1, lastPage: 1, path: "/library/gifts" }) },
    [FREE]: { html: libraryHtml(free, { page: 1, lastPage: 1, path: "/library/free_downloads" }) },
  };
}

function clones(from: number, count: number): { items: FakeLibraryItem[]; routes: Record<string, FakeRoute> } {
  const items = Array.from({ length: count }, (_, index) => ({ id: from + index, name: `架空商品 ${from + index}` }));
  const source = publicItem(6289322) as Record<string, unknown>;
  const routes = Object.fromEntries(items.map((item) => [itemJsonUrlOf(item.id), { json: { ...source, id: item.id } }]));
  return { items, routes };
}

describe("syncLibraryMetadata", () => {
  it("walks library + gifts and fetches at most max_items uncached items", async () => {
    const { items, routes } = clones(8000, 5);
    const reader = new RoutedFakeReader({ ...ownedRoutes(items.slice(0, 4), items.slice(3)), ...routes });
    const { service } = await setup(reader);
    const first = await service.syncLibraryMetadata(3);
    expect(first.data).toMatchObject({ total_items: 5, cached: 0, fetched: 3, remaining: 2, errors: [], truncated: false });
    const second = await service.syncLibraryMetadata();
    expect(second.data).toMatchObject({ total_items: 5, cached: 3, fetched: 2, remaining: 0 });
    expect(reader.count(ITEMS)).toBe(5);
    expect(reader.calls.filter((url) => url === LIBRARY || url === GIFTS)).toEqual([LIBRARY, GIFTS]);
  });

  it("re-reads the library after a login (the owned-items memo is cleared)", async () => {
    const reader = new RoutedFakeReader(ownedRoutes([]));
    const service = new BoothService(reader, {
      env: { BOOTH_MCP_HOME: (await setup(reader)).home },
      login: () => Promise.resolve(),
    });
    await service.syncLibraryMetadata();
    await service.login({ timeoutSec: 60 });
    await service.syncLibraryMetadata();
    expect(reader.calls.filter((url) => url === LIBRARY)).toHaveLength(2);
  });

  it("rejects max_items outside 1..100 before any request", async () => {
    const reader = new RoutedFakeReader();
    const { service } = await setup(reader);
    await expect(service.syncLibraryMetadata(101)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(reader.calls).toEqual([]);
  });
});

describe("Memo", () => {
  it("shares one in-flight load between concurrent callers", async () => {
    const memo = new Memo<number>(60_000);
    let loads = 0;
    const load = async (): Promise<number> => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return loads;
    };
    expect(await Promise.all([memo.get(load), memo.get(load), memo.get(load)])).toEqual([1, 1, 1]);
    expect(await memo.get(load)).toBe(1);
    expect(loads).toBe(1);
  });

  it("forgets a rejected load so the next call retries", async () => {
    const memo = new Memo<string>(60_000);
    const failing = (): Promise<string> => Promise.reject(new Error("boom"));
    await expect(Promise.all([memo.get(failing), memo.get(failing)])).rejects.toThrow("boom");
    expect(await memo.get(() => Promise.resolve("ok"))).toBe("ok");
  });

  it("does not keep a load that finished after clear()", async () => {
    const memo = new Memo<string>(60_000);
    let release: (value: string) => void = () => undefined;
    const gate = new Promise<string>((resolve) => (release = resolve));
    const pending = memo.get(() => gate);
    memo.clear();
    release("stale");
    expect(await pending).toBe("stale");
    expect(await memo.get(() => Promise.resolve("fresh"))).toBe("fresh");
  });

  it("walks the library once for concurrent owned-item calls (list_my_avatars + sync)", async () => {
    const reader = new RoutedFakeReader(ownedRoutes([]));
    const { service } = await setup(reader);
    await Promise.all([service.listMyAvatars(), service.syncLibraryMetadata(), service.syncLibraryMetadata()]);
    // One page each of library, gifts and free downloads (all three tabs share the /library prefix).
    expect(reader.count(LIBRARY)).toBe(3);
    expect(reader.calls.filter((url) => url === LIBRARY)).toHaveLength(1);
    expect(reader.calls.filter((url) => url === GIFTS)).toHaveLength(1);
    expect(reader.calls.filter((url) => url === FREE)).toHaveLength(1);
  });
});

describe("syncAllMetadata", () => {
  it("walks the library once and fetches in batches until nothing remains", async () => {
    const { items, routes } = clones(9000, 45);
    const reader = new RoutedFakeReader({ ...ownedRoutes(items), ...routes });
    const { service } = await setup(reader);
    const progress: number[] = [];
    const result = await service.syncAllMetadata({ onProgress: (step) => progress.push(step.remaining) });
    expect(result.data).toMatchObject({ total_items: 45, fetched: 45, remaining: 0 });
    expect(progress).toEqual([25, 5, 0]);
    expect(reader.count(LIBRARY)).toBe(3);
    expect(reader.count(ITEMS)).toBe(45);
  });

  it("does not retry deleted items and keeps going past them", async () => {
    const { items, routes } = clones(9100, 2);
    const deleted = Array.from({ length: 25 }, (_, index) => ({ id: 9500 + index, name: `削除 ${index}` }));
    const notFound = Object.fromEntries(deleted.map((item) => [itemJsonUrlOf(item.id), new BoothError("NOT_FOUND", "404")]));
    const reader = new RoutedFakeReader({ ...ownedRoutes([...deleted, ...items]), ...routes, ...notFound });
    const { service } = await setup(reader);
    const result = await service.syncAllMetadata();
    expect(result.data).toMatchObject({ fetched: 2, remaining: 0, unavailable: 25, errors: [] });
    expect(reader.count(ITEMS)).toBe(27);
    const again = await service.syncAllMetadata();
    expect(again.data).toMatchObject({ cached: 2, fetched: 0, unavailable: 25 });
    expect(reader.count(ITEMS)).toBe(27);
  });

  it("stops at the first RATE_LIMITED error and reports what remains", async () => {
    const { items, routes } = clones(9200, 30);
    const reader = new RoutedFakeReader({
      ...ownedRoutes(items),
      ...routes,
      [itemJsonUrlOf(9205)]: new BoothError("RATE_LIMITED", "slow down"),
    });
    const { service } = await setup(reader);
    const result = await service.syncAllMetadata();
    expect(result.data).toMatchObject({ fetched: 5, remaining: 25 });
    expect(result.data.errors).toEqual([{ item_id: "9205", code: "RATE_LIMITED", message: "slow down" }]);
    expect(reader.count(ITEMS)).toBe(6);
  });

  it("honours the item budget", async () => {
    const { items, routes } = clones(9300, 30);
    const reader = new RoutedFakeReader({ ...ownedRoutes(items), ...routes });
    const { service } = await setup(reader);
    const result = await service.syncAllMetadata({ maxItems: 25 });
    expect(result.data).toMatchObject({ fetched: 25, remaining: 5 });
  });
});

const AVATARS: FakeLibraryItem[] = [
  { id: 6106863, name: "オリジナル3Dモデル「しなの」" },
  { id: 3681787, name: "オリジナル3Dモデル「桔梗」" },
  { id: 4866933, name: "流行りのビキニ" },
];

function originalAvatar(id: number, name: string): FakeRoute {
  return { json: { ...(publicItem(6106863) as Record<string, unknown>), id, name } };
}

describe("free downloads in owned-item walks", () => {
  it("syncs their metadata but keeps them out of the file-composition snapshot", async () => {
    const { items, routes } = clones(8100, 3);
    const reader = new RoutedFakeReader({ ...ownedRoutes(items.slice(0, 2), [], items.slice(1)), ...routes });
    const { service, home } = await setup(reader);
    const { data } = await service.syncLibraryMetadata();
    expect(data).toMatchObject({ total_items: 3, fetched: 3, remaining: 0, truncated: false });
    const snapshot = await readFile(join(home, "cache", CACHE_SNAPSHOT_FILE_NAME), "utf8");
    expect(snapshot).toContain('"8101"');
    expect(snapshot).not.toContain('"8102"');
  });

  it("lists avatar bodies obtained as free downloads, counting an item listed twice once", async () => {
    const bikini = { id: 4866933, name: "流行りのビキニ" };
    const reader = new RoutedFakeReader({
      ...ownedRoutes([bikini], [], [{ id: 3681787, name: "オリジナル3Dモデル「桔梗」" }, bikini]),
      ...itemRoutes([3681787, 4866933]),
    });
    const { service } = await setup(reader);
    const { data } = await service.listMyAvatars();
    expect(data.avatars.map((avatar) => [avatar.item_id, avatar.avatar_id])).toEqual([["3681787", "kikyo"]]);
    expect(data).toMatchObject({ owned_items: 2, metadata_pending: 0 });
  });
});

describe("listMyAvatars", () => {
  it("lists owned avatar bodies with dictionary ids and suggests unknown ones", async () => {
    const reader = new RoutedFakeReader({
      ...ownedRoutes(AVATARS, [{ id: 777, name: "オリジナル3Dモデル「カクウ」" }]),
      ...itemRoutes([6106863, 3681787, 4866933]),
      [itemJsonUrlOf(777)]: originalAvatar(777, "オリジナル3Dモデル「カクウ」"),
    });
    const { service } = await setup(reader);
    const { data } = await service.listMyAvatars();
    expect(data.avatars.map((avatar) => [avatar.item_id, avatar.avatar_id])).toEqual([
      ["6106863", "shinano"],
      ["3681787", "kikyo"],
      ["777", null],
    ]);
    expect(data.suggestions.map((suggestion) => suggestion.names)).toEqual([["カクウ"]]);
    expect(data.dictionary.some((entry) => entry.id === "shinano")).toBe(true);
    expect(data).toMatchObject({ owned_items: 4, metadata_pending: 0 });
  });
});

describe("initAvatarDictionary", () => {
  it("appends missing avatars to avatars.json and keeps the user's own entries", async () => {
    const reader = new RoutedFakeReader({
      ...ownedRoutes([...AVATARS, { id: 777, name: "カクウ" }]),
      ...itemRoutes([6106863, 3681787, 4866933]),
      [itemJsonUrlOf(777)]: originalAvatar(777, "オリジナル3Dモデル「カクウ」"),
    });
    const { service, home } = await setup(reader);
    const file = join(home, "avatars.json");
    const userEntry = { id: "my_avatar", names: ["マイアバター"], restricted: true };
    await writeFile(file, JSON.stringify({ version: 1, avatars: [userEntry] }), "utf8");
    const { data } = await service.initAvatarDictionary();
    expect(data).toMatchObject({ user_entries_before: 1, metadata_pending: 0 });
    expect(data.added).toEqual([{ id: "avatar_777", names: ["カクウ"], source_item_id: 777 }]);
    const saved = JSON.parse(await readFile(file, "utf8")) as { avatars: Array<{ id: string }> };
    expect(saved.avatars).toEqual([userEntry, { id: "avatar_777", names: ["カクウ"] }]);
    expect(saved.avatars.some((entry) => entry.id === "shinano")).toBe(false);
  });

  it("writes nothing when every owned avatar is already known", async () => {
    const reader = new RoutedFakeReader({ ...ownedRoutes(AVATARS), ...itemRoutes([6106863, 3681787, 4866933]) });
    const { service, home } = await setup(reader);
    const { data } = await service.initAvatarDictionary();
    expect(data.added).toEqual([]);
    await expect(readFile(join(home, "avatars.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
