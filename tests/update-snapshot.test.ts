import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BoothError } from "../src/errors.js";
import {
  buildSnapshot,
  changedItemIdsForCache,
  diffSnapshots,
  getSnapshotFile,
  loadSnapshot,
  mergeSnapshot,
  saveSnapshot,
  type LibrarySnapshot,
} from "../src/library/update-snapshot.js";
import type { LibraryItem } from "../src/parsers/library.js";

const T0 = new Date("2026-10-12T03:00:00.123Z");
const T1 = new Date("2026-10-13T04:05:06.000Z");

function item(id: string, name: string, files: readonly [string, string | null][]): LibraryItem {
  return {
    item_id: id,
    name,
    item_url: `https://booth.pm/ja/items/${id}`,
    shop_name: "Fictional Shop",
    shop_url: "https://fictional-shop.booth.pm/",
    thumbnail_url: null,
    downloadables: files.map(([downloadable_id, file_name]) => ({ downloadable_id, file_name, variation_name: null })),
  };
}

const BASE_ITEMS: readonly LibraryItem[] = [
  item("1001", "Fictional Outfit", [["5001", "FictionalOutfit_v1.0.zip"]]),
  item("1002", "Fictional Hair", [
    ["5002", "FictionalHair.unitypackage"],
    ["5003", "readme.txt"],
  ]),
  item("1003", "Fictional Prop", [["5004", null]]),
];

function snapshotOf(items: readonly LibraryItem[], now: Date = T0): LibrarySnapshot {
  return buildSnapshot(items, now);
}

describe("buildSnapshot", () => {
  it("records items keyed by id with sorted, deduplicated files and a second-precision UTC timestamp", () => {
    const snapshot = buildSnapshot(
      [
        item("1002", "Fictional Hair", [
          ["5010", "b.zip"],
          ["5002", "a.zip"],
          ["5010", "dup.zip"],
        ]),
        item("1001", "Fictional Outfit", [["5001", null]]),
      ],
      T0,
    );

    expect(snapshot).toEqual({
      version: 1,
      taken_at: "2026-10-12T03:00:00Z",
      items: {
        "1001": { name: "Fictional Outfit", files: [{ downloadable_id: "5001", file_name: null }] },
        "1002": {
          name: "Fictional Hair",
          files: [
            { downloadable_id: "5002", file_name: "a.zip" },
            { downloadable_id: "5010", file_name: "b.zip" },
          ],
        },
      },
    });
  });

  it("merges duplicate item ids (library + gifts) keeping the first name and the union of files", () => {
    const snapshot = buildSnapshot(
      [item("1001", "First name", [["5001", "a.zip"]]), item("1001", "Second name", [["5002", "b.zip"]])],
      T0,
    );

    expect(snapshot.items["1001"]).toEqual({
      name: "First name",
      files: [
        { downloadable_id: "5001", file_name: "a.zip" },
        { downloadable_id: "5002", file_name: "b.zip" },
      ],
    });
  });

  it("rejects non-canonical item ids", () => {
    expect(() => buildSnapshot([item("01", "x", [])], T0)).toThrow(BoothError);
  });

  it("does not mutate its input", () => {
    const input = [item("1001", "x", [["5002", "b"], ["5001", "a"]])];
    const before = JSON.stringify(input);
    buildSnapshot(input, T0);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("diffSnapshots", () => {
  it("reports a first run without any comparison", () => {
    const diff = diffSnapshots(null, snapshotOf(BASE_ITEMS));

    expect(diff).toEqual({ first_run: true, changed: [], new_items: [], removed_items: [], unchanged_count: 0 });
  });

  it("reports nothing when the file composition is identical", () => {
    const diff = diffSnapshots(snapshotOf(BASE_ITEMS), snapshotOf(BASE_ITEMS, T1));

    expect(diff).toEqual({ first_run: false, changed: [], new_items: [], removed_items: [], unchanged_count: 3 });
  });

  it("detects added, removed and renamed files by downloadable id", () => {
    const current = snapshotOf([
      item("1001", "Fictional Outfit", [
        ["5001", "FictionalOutfit_v1.0.zip"],
        ["5100", "FictionalOutfit_v1.1.zip"],
      ]),
      item("1002", "Fictional Hair", [["5002", "FictionalHair.unitypackage"]]),
      item("1003", "Fictional Prop", [["5004", "FictionalProp.zip"]]),
    ]);

    const diff = diffSnapshots(snapshotOf(BASE_ITEMS), current);

    expect(diff.first_run).toBe(false);
    expect(diff.unchanged_count).toBe(0);
    expect(diff.changed).toEqual([
      {
        item_id: "1001",
        name: "Fictional Outfit",
        added_files: [{ downloadable_id: "5100", file_name: "FictionalOutfit_v1.1.zip" }],
        removed_files: [],
        renamed_files: [],
      },
      {
        item_id: "1002",
        name: "Fictional Hair",
        added_files: [],
        removed_files: [{ downloadable_id: "5003", file_name: "readme.txt" }],
        renamed_files: [],
      },
      {
        item_id: "1003",
        name: "Fictional Prop",
        added_files: [],
        removed_files: [],
        renamed_files: [{ downloadable_id: "5004", from: null, to: "FictionalProp.zip" }],
      },
    ]);
  });

  it("reports new and removed items, sorted numerically by item id", () => {
    const current = snapshotOf([
      ...BASE_ITEMS.filter((entry) => entry.item_id !== "1002"),
      item("20001", "Big id", []),
      item("999", "Small id", [["6000", "a.zip"]]),
    ]);

    const diff = diffSnapshots(snapshotOf(BASE_ITEMS), current);

    expect(diff.new_items).toEqual([
      { item_id: "999", name: "Small id" },
      { item_id: "20001", name: "Big id" },
    ]);
    expect(diff.removed_items).toEqual([{ item_id: "1002", name: "Fictional Hair" }]);
    expect(diff.unchanged_count).toBe(2);
  });

  it("treats a name-only change as unchanged but reports the current name for changed items", () => {
    const current = snapshotOf([
      item("1001", "Renamed Outfit", [["5001", "FictionalOutfit_v1.0.zip"]]),
      item("1002", "Renamed Hair", [["5002", "FictionalHair.unitypackage"]]),
      item("1003", "Fictional Prop", [["5004", null]]),
    ]);

    const diff = diffSnapshots(snapshotOf(BASE_ITEMS), current);

    expect(diff.unchanged_count).toBe(2);
    expect(diff.changed.map((entry) => [entry.item_id, entry.name])).toEqual([["1002", "Renamed Hair"]]);
  });

  it("restricts the comparison to itemIds (numbers accepted, unknown ids ignored)", () => {
    const current = snapshotOf([
      item("1001", "Fictional Outfit", [["5100", "new.zip"]]),
      item("1002", "Fictional Hair", [["5099", "new.zip"]]),
      item("1004", "New item", []),
    ]);

    const diff = diffSnapshots(snapshotOf(BASE_ITEMS), current, { itemIds: ["1002", 1003, "424242"] });

    expect(diff.changed.map((entry) => entry.item_id)).toEqual(["1002"]);
    expect(diff.new_items).toEqual([]);
    expect(diff.removed_items).toEqual([{ item_id: "1003", name: "Fictional Prop" }]);
    expect(diff.unchanged_count).toBe(0);
  });

  it("rejects invalid itemIds with INVALID_INPUT", () => {
    let caught: unknown;
    try {
      diffSnapshots(null, snapshotOf(BASE_ITEMS), { itemIds: ["../x"] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BoothError);
    expect(caught).toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("changedItemIdsForCache", () => {
  it("returns the ids whose file composition changed, excluding new and removed items", () => {
    const current = snapshotOf([
      item("1001", "Fictional Outfit", [["5100", "new.zip"]]),
      BASE_ITEMS[1] as LibraryItem,
      item("1005", "New item", [["7000", "x.zip"]]),
    ]);

    const ids = changedItemIdsForCache(diffSnapshots(snapshotOf(BASE_ITEMS), current));

    expect(ids).toEqual(["1001"]);
  });

  it("is empty on a first run", () => {
    expect(changedItemIdsForCache(diffSnapshots(null, snapshotOf(BASE_ITEMS)))).toEqual([]);
  });
});

describe("mergeSnapshot", () => {
  const previous = snapshotOf(BASE_ITEMS);
  const current = snapshotOf(
    [item("1001", "Fictional Outfit", [["5100", "new.zip"]]), item("1002", "Fictional Hair", [["5099", "new.zip"]])],
    T1,
  );

  it("returns the current snapshot when no itemIds are given or there is no previous snapshot", () => {
    expect(mergeSnapshot(previous, current)).toBe(current);
    expect(mergeSnapshot(null, current, { itemIds: ["1001"] })).toBe(current);
  });

  it("only updates the checked items so unreported changes stay detectable", () => {
    const merged = mergeSnapshot(previous, current, { itemIds: ["1001", "1003"] });

    expect(merged.taken_at).toBe(current.taken_at);
    expect(merged.items["1001"]).toEqual(current.items["1001"]);
    expect(merged.items["1002"]).toEqual(previous.items["1002"]);
    expect(merged.items["1003"]).toBeUndefined();
    expect(diffSnapshots(merged, current).changed.map((entry) => entry.item_id)).toEqual(["1002"]);
  });
});

describe("snapshot persistence", () => {
  let root: string;
  let file: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "booth-snapshot-"));
    file = join(root, "nested", "dir", "library-snapshot.json");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("defaults to library-snapshot.json in the cache dir", () => {
    expect(getSnapshotFile({ BOOTH_MCP_CACHE_DIR: join(root, "cache") })).toBe(join(root, "cache", "library-snapshot.json"));
  });

  it("returns null without the corrupt flag when the file is missing", async () => {
    await expect(loadSnapshot(file)).resolves.toEqual({ snapshot: null, corrupt: false });
  });

  it("round-trips through an atomic write that creates parent directories", async () => {
    const snapshot = snapshotOf(BASE_ITEMS);

    await saveSnapshot(snapshot, file);

    await expect(loadSnapshot(file)).resolves.toEqual({ snapshot, corrupt: false });
    expect(await readdir(join(root, "nested", "dir"))).toEqual(["library-snapshot.json"]);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(snapshot);
  });

  it.skipIf(process.platform === "win32")("writes the file with owner-only permissions", async () => {
    await saveSnapshot(snapshotOf(BASE_ITEMS), file);

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "nested", "dir"))).mode & 0o777).toBe(0o700);
  });

  it("overwrites an existing snapshot", async () => {
    await saveSnapshot(snapshotOf(BASE_ITEMS), file);
    const next = snapshotOf([BASE_ITEMS[0] as LibraryItem], T1);

    await saveSnapshot(next, file);

    await expect(loadSnapshot(file)).resolves.toEqual({ snapshot: next, corrupt: false });
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["an unknown version", JSON.stringify({ version: 2, taken_at: "2026-10-12T03:00:00Z", items: {} })],
    ["a bad timestamp", JSON.stringify({ version: 1, taken_at: "yesterday", items: {} })],
    ["a non-numeric item id", JSON.stringify({ version: 1, taken_at: "2026-10-12T03:00:00Z", items: { abc: { name: "x", files: [] } } })],
    [
      "a malformed file entry",
      JSON.stringify({ version: 1, taken_at: "2026-10-12T03:00:00Z", items: { "1": { name: "x", files: [{ file_name: 1 }] } } }),
    ],
  ])("reports a corrupt file with %s instead of throwing", async (_label, content) => {
    await mkdir(join(root, "nested", "dir"), { recursive: true });
    await writeFile(file, content, "utf8");

    const result = await loadSnapshot(file);

    expect(result.snapshot).toBeNull();
    expect(result.corrupt).toBe(true);
  });

  it("reports an unreadable path (a directory) as corrupt", async () => {
    await mkdir(file, { recursive: true });

    await expect(loadSnapshot(file)).resolves.toMatchObject({ snapshot: null, corrupt: true });
  });

  it("throws a path-free error when the snapshot cannot be written", async () => {
    await mkdir(file, { recursive: true });

    const error: unknown = await saveSnapshot(snapshotOf(BASE_ITEMS), file).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(root);
    expect(await readdir(join(root, "nested", "dir"))).toEqual(["library-snapshot.json"]);
  });
});
