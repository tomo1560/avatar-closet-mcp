import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AvatarDictionaryError,
  SEED_AVATARS,
  loadAvatarDictionary,
  mergeAvatarDictionaries,
  readUserAvatarEntries,
  saveAvatarDictionary,
  suggestAvatarsFromLibrary,
} from "../src/vrchat/avatars.js";
import type { VrchatItemInput } from "../src/vrchat/types.js";

const ITEMS_DIR = join(import.meta.dirname, "fixtures", "public", "items");

function fixture(id: number): VrchatItemInput {
  return JSON.parse(readFileSync(join(ITEMS_DIR, `${id}.json`), "utf8")) as VrchatItemInput;
}

function body(id: number, name: string): VrchatItemInput {
  return { id, name, description: "", category: { id: 208, name: "3Dキャラクター" }, tags: [], variations: [{ name: null }] };
}

describe("seed dictionary", () => {
  it("has unique ids and covers every labelled avatar", () => {
    const labels = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "public", "compat-labels.json"), "utf8")) as Record<
      string,
      { compatible: string[]; avatar_id?: string }
    >;
    const ids = new Set(SEED_AVATARS.map((entry) => entry.id));
    expect(ids.size).toBe(SEED_AVATARS.length);
    for (const label of Object.values(labels)) {
      for (const avatar of [...label.compatible, ...(label.avatar_id ? [label.avatar_id] : [])]) expect(ids).toContain(avatar);
    }
  });
});

describe("avatar dictionary files", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "booth-avatars-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("falls back to the seed when the file is missing", async () => {
    expect(await loadAvatarDictionary(join(dir, "missing.json"))).toEqual(SEED_AVATARS);
    expect(await readUserAvatarEntries(join(dir, "missing.json"))).toEqual([]);
  });

  it("lets user entries override and extend the seed by id", async () => {
    // Arrange
    const file = join(dir, "avatars.json");
    const user = [
      { id: "shinano", names: ["しなの", "Shinano", "しなのん"] },
      { id: "lucifer", names: ["ルキフェル"], restricted: true },
    ];
    await writeFile(file, JSON.stringify({ avatars: user }), "utf8");

    // Act
    const dictionary = await loadAvatarDictionary(file);

    // Assert
    expect(dictionary.find((e) => e.id === "shinano")?.names).toContain("しなのん");
    expect(dictionary.find((e) => e.id === "lucifer")).toEqual({ id: "lucifer", names: ["ルキフェル"], restricted: true });
    expect(dictionary).toHaveLength(SEED_AVATARS.length + 1);
  });

  it("accepts a bare array of entries", async () => {
    const file = join(dir, "avatars.json");
    const bom = String.fromCharCode(0xfeff);
    await writeFile(file, `${bom}${JSON.stringify([{ id: "x", names: ["エックス"] }])}`, "utf8");
    expect(await readUserAvatarEntries(file)).toEqual([{ id: "x", names: ["エックス"] }]);
  });

  it("rejects invalid JSON and invalid entries", async () => {
    const file = join(dir, "avatars.json");
    await writeFile(file, "{ not json", "utf8");
    await expect(loadAvatarDictionary(file)).rejects.toBeInstanceOf(AvatarDictionaryError);
    await writeFile(file, JSON.stringify({ avatars: [{ id: "", names: "しなの" }] }), "utf8");
    await expect(loadAvatarDictionary(file)).rejects.toThrow(/Invalid avatar dictionary/);
  });

  it("saves atomically into a new directory and round-trips", async () => {
    // Arrange
    const file = join(dir, "nested", "deeper", "avatars.json");
    const entries = [{ id: "lucifer", names: ["ルキフェル"], restricted_names: ["ルキ"] }];

    // Act
    await saveAvatarDictionary(entries, file);

    // Assert
    expect(await readUserAvatarEntries(file)).toEqual(entries);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1 });
    expect((await readdir(join(dir, "nested", "deeper"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses to save invalid entries", async () => {
    await expect(saveAvatarDictionary([{ id: "", names: [] }], join(dir, "a.json"))).rejects.toBeInstanceOf(AvatarDictionaryError);
  });
});

describe("mergeAvatarDictionaries", () => {
  it("does not mutate its inputs", () => {
    const base = [{ id: "a", names: ["A"] }];
    const merged = mergeAvatarDictionaries(base, [{ id: "a", names: ["B"] }]);
    expect(base).toEqual([{ id: "a", names: ["A"] }]);
    expect(merged).toEqual([{ id: "a", names: ["B"] }]);
  });
});

describe("suggestAvatarsFromLibrary", () => {
  it("suggests real avatar bodies and skips add-ons and other kinds", () => {
    // Arrange: しなの / 桔梗 bodies, しなの prefab add-on (category 208), a costume.
    const items = [fixture(6106863), fixture(3681787), fixture(6115428), fixture(4866933)];

    // Act
    const suggestions = suggestAvatarsFromLibrary(items);

    // Assert
    expect(suggestions.map((s) => [s.id_suggestion, s.source_item_id, s.in_dictionary])).toEqual([
      ["shinano", 6106863, true],
      ["kikyo", 3681787, true],
    ]);
    expect(suggestions[0]?.names).toEqual(expect.arrayContaining(["しなの", "Shinano"]));
  });

  it("derives names and ids for avatars missing from the dictionary", () => {
    const suggestions = suggestAvatarsFromLibrary([
      body(10, "ライム -Lime- オリジナル3Dモデル"),
      body(11, "オリジナル3Dモデル「ほしぞら」"),
      body(12, "Nova -ノヴァ- Original 3D Avatar"),
    ]);
    expect(suggestions).toEqual([
      { id_suggestion: "lime", names: ["ライム", "Lime"], source_item_id: 10, in_dictionary: true },
      { id_suggestion: "avatar_11", names: ["ほしぞら"], source_item_id: 11, in_dictionary: false },
      { id_suggestion: "nova", names: ["Nova", "ノヴァ"], source_item_id: 12, in_dictionary: false },
    ]);
  });

  it("de-duplicates suggestions by id", () => {
    expect(suggestAvatarsFromLibrary([fixture(6106863), fixture(6106863)])).toHaveLength(1);
  });
});
