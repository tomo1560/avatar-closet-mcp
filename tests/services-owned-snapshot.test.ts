import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoothError } from "../src/errors.js";
import { BoothService } from "../src/service.js";
import { libraryHtml, type FakeLibraryItem } from "./helpers/buyer-html.js";
import { itemJsonUrlOf, publicItem, RoutedFakeReader, type FakeRoute } from "./helpers/fake-reader.js";

const LIBRARY = "https://accounts.booth.pm/library";
const GIFTS = "https://accounts.booth.pm/library/gifts";
const FREE = "https://accounts.booth.pm/library/free_downloads";
const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "booth-library-mcp-owned-"));
  tempPaths.push(home);
  return home;
}

function itemJson(id: number): FakeRoute {
  return { json: { ...(publicItem(6289322) as Record<string, unknown>), id } };
}

function ownedRoutes(library: readonly FakeLibraryItem[]): Record<string, FakeRoute> {
  return {
    [LIBRARY]: { html: libraryHtml(library, { page: 1, lastPage: 1 }) },
    [GIFTS]: { html: libraryHtml([], { page: 1, lastPage: 1, path: "/library/gifts" }) },
    [FREE]: { html: libraryHtml([], { page: 1, lastPage: 1, path: "/library/free_downloads" }) },
  };
}

function cacheSnapshotPath(home: string): string {
  return join(home, "cache", "item-cache-snapshot.json");
}

async function snapshotFiles(home: string, id: number): Promise<string[]> {
  const snapshot = JSON.parse(await readFile(cacheSnapshotPath(home), "utf8")) as {
    items: Record<string, { files: Array<{ downloadable_id: string }> }>;
  };
  return (snapshot.items[String(id)]?.files ?? []).map((file) => file.downloadable_id);
}

const BEFORE: FakeLibraryItem[] = [
  { id: 7001, name: "架空衣装", files: [{ id: 11, name: "Outfit_v1.zip" }] },
  { id: 7002, name: "架空小物", files: [{ id: 21, name: "Prop_v1.zip" }] },
];
const AFTER: FakeLibraryItem[] = [
  { id: 7001, name: "架空衣装", files: [{ id: 11, name: "Outfit_v1.zip" }, { id: 12, name: "Outfit_v2.zip" }] },
  { id: 7002, name: "架空小物", files: [{ id: 21, name: "Prop_v1.zip" }] },
];

describe("metadata re-fetch for items whose download files changed (PLAN §3.5.7)", () => {
  it("re-fetches a changed item even when its cache record is fresh, and only once", async () => {
    const home = await tempHome();
    const items = { [itemJsonUrlOf(7001)]: itemJson(7001), [itemJsonUrlOf(7002)]: itemJson(7002) };
    const first = new RoutedFakeReader({ ...ownedRoutes(BEFORE), ...items });
    await new BoothService(first, { env: { BOOTH_MCP_HOME: home } }).syncLibraryMetadata();
    expect(await snapshotFiles(home, 7001)).toEqual(["11"]);

    const second = new RoutedFakeReader({ ...ownedRoutes(AFTER), ...items });
    const service = new BoothService(second, { env: { BOOTH_MCP_HOME: home } });
    const result = await service.syncLibraryMetadata();
    expect(result.data).toMatchObject({ total_items: 2, cached: 1, fetched: 1, remaining: 0 });
    expect(second.count(itemJsonUrlOf(7001))).toBe(1);
    expect(second.count(itemJsonUrlOf(7002))).toBe(0);
    expect(await snapshotFiles(home, 7001)).toEqual(["11", "12"]);

    await service.syncLibraryMetadata();
    expect(second.count(itemJsonUrlOf(7001))).toBe(1);
  });

  it("also applies to the owned-avatar listing", async () => {
    const home = await tempHome();
    const items = { [itemJsonUrlOf(7001)]: itemJson(7001), [itemJsonUrlOf(7002)]: itemJson(7002) };
    await new BoothService(new RoutedFakeReader({ ...ownedRoutes(BEFORE), ...items }), { env: { BOOTH_MCP_HOME: home } }).listMyAvatars();
    const reader = new RoutedFakeReader({ ...ownedRoutes(AFTER), ...items });
    await new BoothService(reader, { env: { BOOTH_MCP_HOME: home } }).listMyAvatars();
    expect(reader.count(itemJsonUrlOf(7001))).toBe(1);
    expect(reader.count(itemJsonUrlOf(7002))).toBe(0);
  });

  it("keeps a changed item pending when the re-fetch fails, and retries it next time", async () => {
    const home = await tempHome();
    const items = { [itemJsonUrlOf(7001)]: itemJson(7001), [itemJsonUrlOf(7002)]: itemJson(7002) };
    await new BoothService(new RoutedFakeReader({ ...ownedRoutes(BEFORE), ...items }), { env: { BOOTH_MCP_HOME: home } }).syncLibraryMetadata();

    const failing = new RoutedFakeReader({ ...ownedRoutes(AFTER), ...items, [itemJsonUrlOf(7001)]: new BoothError("RATE_LIMITED", "slow down") });
    await new BoothService(failing, { env: { BOOTH_MCP_HOME: home } }).syncLibraryMetadata();
    expect(await snapshotFiles(home, 7001)).toEqual(["11"]);

    const retry = new RoutedFakeReader({ ...ownedRoutes(AFTER), ...items });
    await new BoothService(retry, { env: { BOOTH_MCP_HOME: home } }).syncLibraryMetadata();
    expect(retry.count(itemJsonUrlOf(7001))).toBe(1);
    expect(await snapshotFiles(home, 7001)).toEqual(["11", "12"]);
  });

  it("never records a page-capped walk", async () => {
    const home = await tempHome();
    const pages = Array.from({ length: 21 }, (_, index) => index + 1);
    const routes: Record<string, FakeRoute> = Object.fromEntries(
      pages.map((page) => [
        page === 1 ? LIBRARY : `${LIBRARY}?page=${page}`,
        { html: libraryHtml([{ id: 8000 + page, name: `架空 ${page}` }], { page, lastPage: 30 }) },
      ]),
    );
    const reader = new RoutedFakeReader({
      ...routes,
      [GIFTS]: { html: libraryHtml([], { page: 1, lastPage: 1, path: "/library/gifts" }) },
      [FREE]: { html: libraryHtml([], { page: 1, lastPage: 1, path: "/library/free_downloads" }) },
      ...Object.fromEntries(pages.map((page) => [itemJsonUrlOf(8000 + page), itemJson(8000 + page)])),
    });
    const result = await new BoothService(reader, { env: { BOOTH_MCP_HOME: home } }).syncLibraryMetadata();
    expect(result.data.truncated).toBe(true);
    await expect(stat(cacheSnapshotPath(home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("warns instead of failing when the snapshot cannot be written", async () => {
    const home = await tempHome();
    await mkdir(join(cacheSnapshotPath(home), "blocked"), { recursive: true });
    const warnings: string[] = [];
    const reader = new RoutedFakeReader({ ...ownedRoutes(BEFORE), [itemJsonUrlOf(7001)]: itemJson(7001), [itemJsonUrlOf(7002)]: itemJson(7002) });
    const service = new BoothService(reader, { env: { BOOTH_MCP_HOME: home }, warn: (message) => warnings.push(message) });
    const result = await service.syncLibraryMetadata();
    expect(result.data).toMatchObject({ fetched: 2, remaining: 0 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(home);
  });
});
