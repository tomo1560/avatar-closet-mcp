import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoothService } from "../src/service.js";
import { libraryHtml, type FakeLibraryItem } from "./helpers/buyer-html.js";
import { itemJsonUrlOf, itemRoutes, publicItem, RoutedFakeReader, type FakeRoute } from "./helpers/fake-reader.js";

const LIBRARY = "https://accounts.booth.pm/library";
const GIFTS = "https://accounts.booth.pm/library/gifts";
const ITEMS = "https://booth.pm/ja/items/";
const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "booth-library-mcp-updates-"));
  tempPaths.push(home);
  return home;
}

function ownedRoutes(library: readonly FakeLibraryItem[], gifts: readonly FakeLibraryItem[] = []): Record<string, FakeRoute> {
  return {
    [LIBRARY]: { html: libraryHtml(library, { page: 1, lastPage: 1 }) },
    [GIFTS]: { html: libraryHtml(gifts, { page: 1, lastPage: 1, path: "/library/gifts" }) },
  };
}

function serviceFor(home: string, routes: Record<string, FakeRoute>, warn?: (message: string) => void): { service: BoothService; reader: RoutedFakeReader } {
  const reader = new RoutedFakeReader(routes);
  return { service: new BoothService(reader, { env: { BOOTH_MCP_HOME: home }, ...(warn ? { warn } : {}) }), reader };
}

const baselinePath = (home: string): string => join(home, "cache", "library-snapshot.json");

const BEFORE: FakeLibraryItem[] = [
  { id: 7001, name: "架空衣装", files: [{ id: 11, name: "Outfit_v1.zip" }] },
  { id: 7002, name: "架空小物", files: [{ id: 21, name: "Prop_v1.zip" }] },
];
const AFTER: FakeLibraryItem[] = [
  { id: 7001, name: "架空衣装", files: [{ id: 11, name: "Outfit_v1.zip" }, { id: 12, name: "Outfit_v2.zip" }] },
  { id: 7003, name: "架空ヘア", files: [{ id: 31, name: "Hair.zip" }] },
];

describe("checkUpdates (booth_check_updates)", () => {
  it("records a baseline on the first run without requesting item data", async () => {
    const home = await tempHome();
    const { service, reader } = serviceFor(home, ownedRoutes(BEFORE));
    const { data, meta } = await service.checkUpdates();
    expect(data).toMatchObject({
      first_run: true,
      complete: true,
      changed: [],
      new_items: [],
      removed_items: [],
      unchanged_count: 0,
      previous_snapshot_taken_at: null,
      snapshot_saved: true,
      owned_items: 2,
      warnings: [],
    });
    expect(data.note).toContain("基準");
    expect(meta.sourceUrl).toBe(LIBRARY);
    expect(reader.count(ITEMS)).toBe(0);
    await expect(stat(baselinePath(home))).resolves.toBeTruthy();
  });

  it("reports added, removed and changed items against the previous check", async () => {
    const home = await tempHome();
    const first = await serviceFor(home, ownedRoutes(BEFORE)).service.checkUpdates();
    const { data } = await serviceFor(home, ownedRoutes(AFTER)).service.checkUpdates();
    expect(data).toMatchObject({
      first_run: false,
      changed: [
        {
          item_id: "7001",
          name: "架空衣装",
          added_files: [{ downloadable_id: "12", file_name: "Outfit_v2.zip" }],
          removed_files: [],
          renamed_files: [],
        },
      ],
      new_items: [{ item_id: "7003", name: "架空ヘア" }],
      removed_items: [{ item_id: "7002", name: "架空小物" }],
      unchanged_count: 0,
      previous_snapshot_taken_at: first.data.snapshot_taken_at,
    });
    const again = await serviceFor(home, ownedRoutes(AFTER)).service.checkUpdates();
    expect(again.data).toMatchObject({ changed: [], new_items: [], removed_items: [], unchanged_count: 2 });
  });

  it("is not affected by sync (which keeps its own file-composition snapshot)", async () => {
    const home = await tempHome();
    await serviceFor(home, ownedRoutes(BEFORE)).service.checkUpdates();
    const items = { [itemJsonUrlOf(7001)]: { json: { ...(publicItem(6289322) as object), id: 7001 } }, [itemJsonUrlOf(7003)]: { json: { ...(publicItem(6289322) as object), id: 7003 } } };
    const { service } = serviceFor(home, { ...ownedRoutes(AFTER), ...items });
    await service.syncLibraryMetadata();
    const { data } = await service.checkUpdates();
    expect(data.changed.map((entry) => entry.item_id)).toEqual(["7001"]);
  });

  it("limits the check to item_ids and keeps other changes for a later check", async () => {
    const home = await tempHome();
    await serviceFor(home, ownedRoutes(BEFORE)).service.checkUpdates();
    const scoped = await serviceFor(home, ownedRoutes(AFTER)).service.checkUpdates({ itemIds: ["7002", " 9999 "] });
    expect(scoped.data).toMatchObject({
      changed: [],
      new_items: [],
      removed_items: [{ item_id: "7002" }],
      filters: { item_ids: ["7002", "9999"] },
      unknown_item_ids: ["9999"],
    });
    const rest = await serviceFor(home, ownedRoutes(AFTER)).service.checkUpdates();
    expect(rest.data).toMatchObject({ changed: [{ item_id: "7001" }], new_items: [{ item_id: "7003" }], removed_items: [] });
  });

  it("with avatar, keeps only supported changed/new items and leaves the others for a later check", async () => {
    const home = await tempHome();
    const before: FakeLibraryItem[] = [
      { id: 6289322, name: "【しなの対応】Vigilant Style", files: [{ id: 1, name: "Vigilant_v1.zip" }] },
      { id: 3087170, name: "【無料】lilToon", files: [{ id: 2, name: "lilToon_1.7.zip" }] },
    ];
    const after: FakeLibraryItem[] = before.map((item, index) => ({ ...item, files: [...(item.files ?? []), { id: 10 + index, name: `update_${index}.zip` }] }));
    await serviceFor(home, ownedRoutes(before)).service.checkUpdates();
    const { service, reader } = serviceFor(home, { ...ownedRoutes(after), ...itemRoutes([6289322, 3087170]) });
    const { data } = await service.checkUpdates({ avatar: "しなの" });
    expect(data.changed.map((entry) => entry.item_id)).toEqual(["6289322"]);
    expect(data.changed[0]?.compatibility).toMatchObject({ result: "supported" });
    expect(data).toMatchObject({ filters: { avatar: "しなの" }, metadata_pending: 0 });
    expect(reader.count(ITEMS)).toBe(2);
    const plain = await serviceFor(home, ownedRoutes(after)).service.checkUpdates();
    expect(plain.data.changed.map((entry) => entry.item_id)).toEqual(["3087170"]);
  });

  it("refuses to compare or record a page-capped listing", async () => {
    const home = await tempHome();
    const pages = Array.from({ length: 20 }, (_, index) => index + 1);
    const routes: Record<string, FakeRoute> = Object.fromEntries(
      pages.map((page) => [page === 1 ? LIBRARY : `${LIBRARY}?page=${page}`, { html: libraryHtml([{ id: 8000 + page, name: `架空 ${page}` }], { page, lastPage: 30 }) }]),
    );
    const { service } = serviceFor(home, { ...routes, [GIFTS]: { html: libraryHtml([], { page: 1, lastPage: 1, path: "/library/gifts" }) } });
    const { data } = await service.checkUpdates();
    expect(data).toMatchObject({ complete: false, first_run: false, changed: [], snapshot_saved: false, snapshot_taken_at: null });
    expect(data.warnings.join(" ")).toContain("全件");
    await expect(stat(baselinePath(home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats an unreadable baseline as a first run and says so", async () => {
    const home = await tempHome();
    await mkdir(join(home, "cache"), { recursive: true });
    await writeFile(baselinePath(home), "{broken");
    const { data } = await serviceFor(home, ownedRoutes(BEFORE)).service.checkUpdates();
    expect(data.first_run).toBe(true);
    expect(data.warnings.join(" ")).toContain("読めなかった");
    expect(JSON.parse(await readFile(baselinePath(home), "utf8"))).toMatchObject({ version: 1 });
  });

  it("reports a baseline that cannot be written as a warning in the result", async () => {
    const home = await tempHome();
    await mkdir(join(baselinePath(home), "blocked"), { recursive: true });
    const { data } = await serviceFor(home, ownedRoutes(BEFORE)).service.checkUpdates();
    expect(data.snapshot_saved).toBe(false);
    expect(data.warnings.some((warning) => warning.includes("書き込めませんでした"))).toBe(true);
    expect(data.warnings.join(" ")).not.toContain(home);
  });

  it.each([[[]], [["abc"]], [["0123"]], [Array.from({ length: 101 }, (_, index) => String(index + 1))]])(
    "rejects invalid item_ids %# before any request",
    async (itemIds) => {
      const home = await tempHome();
      const { service, reader } = serviceFor(home, {});
      await expect(service.checkUpdates({ itemIds })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(reader.calls).toEqual([]);
    },
  );
});
