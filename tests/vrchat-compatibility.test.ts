import { describe, expect, it } from "vitest";

import { checkCompatibility, extractCompatibility } from "../src/vrchat/compatibility.js";
import { SEED_AVATARS } from "../src/vrchat/seed-avatars.js";
import type { CompatibilityResult, VrchatItemInput } from "../src/vrchat/types.js";

interface ItemOverrides {
  readonly name?: string;
  readonly description?: string;
  readonly categoryId?: number;
  readonly tags?: readonly string[];
  readonly variations?: readonly (string | null)[];
}

function makeItem(overrides: ItemOverrides = {}): VrchatItemInput {
  return {
    id: 1,
    name: overrides.name ?? "テスト衣装",
    description: overrides.description ?? "",
    category: { id: overrides.categoryId ?? 209, name: "3D衣装" },
    tags: (overrides.tags ?? []).map((name) => ({ name })),
    variations: (overrides.variations ?? [null]).map((name) => ({ name })),
  };
}

function compatibleIds(result: CompatibilityResult): string[] {
  return result.compatible_avatars.map((c) => c.avatar).sort();
}

function find(result: CompatibilityResult, avatar: string) {
  return result.compatible_avatars.find((c) => c.avatar === avatar);
}

describe("extractCompatibility sources and confidence", () => {
  it("reports variation, tag and heading matches as high", () => {
    const item = makeItem({
      tags: ["しなの対応"],
      variations: ["桔梗用 - Kikyo"],
      description: "対応アバター：マヌカ",
    });
    const result = extractCompatibility(item, SEED_AVATARS);
    expect(find(result, "kikyo")).toMatchObject({ confidence: "high", source: "variation" });
    // Variation-split item: the tag/heading-only avatars have no purchasable version.
    expect(compatibleIds(result)).toEqual(["kikyo"]);
  });

  it("uses tags and the item name when variations are not per avatar", () => {
    const item = makeItem({ name: "ワンピース（桔梗用）", tags: ["Shinano用"] });
    const result = extractCompatibility(item, SEED_AVATARS);
    expect(find(result, "shinano")).toMatchObject({ confidence: "high", source: "tag", evidence: "Shinano用" });
    expect(find(result, "kikyo")).toMatchObject({ confidence: "medium", source: "name" });
  });

  it("treats free description mentions as low and keeps the highest confidence per avatar", () => {
    const item = makeItem({ description: "しなのちゃんにも着せられます", tags: ["マヌカ"] });
    const result = extractCompatibility(item, SEED_AVATARS);
    expect(find(result, "shinano")).toMatchObject({ confidence: "low", source: "description" });
    expect(find(result, "manuka")).toMatchObject({ confidence: "high" });
    expect(result.compatible_avatars.filter((c) => c.avatar === "manuka")).toHaveLength(1);
  });

  it("matches katakana, hiragana, half-width and English aliases", () => {
    for (const tag of ["シナノ対応", "ｼﾅﾉ", "SHINANO", "しなのちゃん用", "shinano3D"]) {
      const result = extractCompatibility(makeItem({ tags: [tag] }), SEED_AVATARS);
      expect(compatibleIds(result)).toEqual(["shinano"]);
    }
  });

  it("splits multi-avatar variation names", () => {
    const item = makeItem({
      variations: ["セレスティア・竜胆用・マヌカ（Selestia・Rindo・Manuka）", "Kikyo Moe Selestia", "MameFriends (Kipfel / Mamehinata)", "Fullset"],
    });
    expect(compatibleIds(extractCompatibility(item, SEED_AVATARS))).toEqual([
      "kikyo", "kipfel", "mamehinata", "manuka", "moe", "rindo", "selestia",
    ]);
  });
});

describe("heading blocks", () => {
  it("reads lines after 対応アバター across blank lines until a separator", () => {
    const description = [
      "対応アバター",
      "",
      "オリジナル3Dモデル「桔梗」",
      "https://booth.pm/ja/items/3681787",
      "",
      "『ライム』-Lime-",
      "－－－－－－－－",
      "ライムグリーンのリボン付き",
    ].join("\n");
    const result = extractCompatibility(makeItem({ description }), SEED_AVATARS);
    expect(find(result, "kikyo")).toMatchObject({ confidence: "high", source: "description_heading" });
    expect(find(result, "lime")).toMatchObject({ confidence: "high", source: "description_heading", evidence: "『ライム』-Lime-" });
    expect(compatibleIds(result)).toEqual(["kikyo", "lime"]);
  });

  it("supports inline and bracketed headings and stops at the next section", () => {
    const description = "【対応】萌、ライム\n本体は付属しません\n\n●注意\n真冬に着たい衣装です";
    const result = extractCompatibility(makeItem({ description }), SEED_AVATARS);
    expect(compatibleIds(result)).toEqual(["lime", "moe"]);
  });

  it("does not treat a sentence starting with 対応アバター as a heading", () => {
    const description = "対応アバターが増えました\n萌え袖がポイント";
    expect(extractCompatibility(makeItem({ description }), SEED_AVATARS).compatible_avatars).toEqual([]);
  });

  it("downgrades names outside the heading list to low", () => {
    const description = "対応アバター\n【Lapwing】\n【しなの】";
    const result = extractCompatibility(makeItem({ description, tags: ["PlusHead対応"] }), SEED_AVATARS);
    expect(find(result, "plushead")).toMatchObject({ confidence: "low", source: "tag" });
    expect(find(result, "lapwing")?.confidence).toBe("high");
  });
});

describe("restricted short / ambiguous names", () => {
  it("ignores common words in the name and free description", () => {
    const item = makeItem({ name: "萌え袖ニット", description: "ライムグリーンとシフォン素材。真冬にぴったり。マヌカハニー色" });
    expect(extractCompatibility(item, SEED_AVATARS).compatible_avatars).toEqual([]);
  });

  it("accepts restricted names with an explicit suffix or next to other avatar names", () => {
    const item = makeItem({ name: "流行りのビキニ【愛莉 桔梗 萌 しなの】", description: "ライム用に調整済み" });
    const result = extractCompatibility(item, SEED_AVATARS);
    expect(find(result, "moe")).toMatchObject({ confidence: "medium", source: "name" });
    expect(find(result, "airi")?.source).toBe("name");
    expect(find(result, "lime")).toMatchObject({ confidence: "low", source: "description" });
  });

  it("accepts restricted names as whole tags and variations", () => {
    const result = extractCompatibility(makeItem({ tags: ["萌"], variations: [null] }), SEED_AVATARS);
    expect(find(result, "moe")?.confidence).toBe("high");
    expect(extractCompatibility(makeItem({ tags: ["萌え"] }), SEED_AVATARS).compatible_avatars).toEqual([]);
  });

  it("ignores links to other products", () => {
    const description = "真冬用、サリア用はこちらにあります！\n\n（真冬）https://booth.pm/ja/items/1\n（サリア）https://booth.pm/ja/items/2";
    expect(extractCompatibility(makeItem({ description }), SEED_AVATARS).compatible_avatars).toEqual([]);
  });
});

describe("negation", () => {
  it.each([
    ["本衣装は桔梗には非対応です。", ["kikyo"]],
    ["しなの、桔梗は対象外となります", ["kikyo", "shinano"]],
    ["マヌカ不可", ["manuka"]],
    ["萌には対応しておりません。", ["moe"]],
    ["Not compatible with Shinano.", ["shinano"]],
    ["非対応アバター：セレスティア", ["selestia"]],
  ])("detects %s", (description, expected) => {
    const result = extractCompatibility(makeItem({ description, tags: ["しなの対応", "桔梗", "マヌカ", "萌", "セレスティア"] }), SEED_AVATARS);
    expect(result.not_supported.map((n) => n.avatar).sort()).toEqual(expected);
    for (const avatar of expected) expect(find(result, avatar)).toBeUndefined();
  });

  it("does not treat version constraints or partial support as negation", () => {
    const description =
      "ミルティナちゃん用は1.01.1を想定して対応されています。それ以前のバージョンはサポートしておりません。\n※しなのはBreast_Flatにのみ対応しています";
    const result = extractCompatibility(makeItem({ description, tags: ["ミルティナ", "しなの"] }), SEED_AVATARS);
    expect(result.not_supported).toEqual([]);
    expect(compatibleIds(result)).toEqual(["milltina", "shinano"]);
  });

  it("reads negated tags", () => {
    const result = extractCompatibility(makeItem({ tags: ["桔梗非対応", "しなの"] }), SEED_AVATARS);
    expect(result.not_supported).toEqual([{ avatar: "kikyo", evidence: "桔梗非対応" }]);
  });
});

describe("ownership", () => {
  it("reports owned versions from downloaded file names", () => {
    const item = makeItem({ tags: ["しなの", "桔梗"] });
    const result = extractCompatibility(item, SEED_AVATARS, { ownedFileNames: ["Outfit_Shinano_v1.2.zip", "OutfitKikyo.unitypackage"] });
    expect(result.owned_versions).toEqual([
      { avatar: "shinano", evidence: "Outfit_Shinano_v1.2.zip" },
      { avatar: "kikyo", evidence: "OutfitKikyo.unitypackage" },
    ]);
  });

  it("adds file-name evidence as medium confidence", () => {
    const result = extractCompatibility(makeItem(), SEED_AVATARS, { ownedFileNames: ["Outfit_Shinano_v1.2.zip"] });
    expect(find(result, "shinano")).toMatchObject({ confidence: "medium", source: "file_name" });
  });

  it("ignores restricted names in file names unless the item already names that avatar", () => {
    const result = extractCompatibility(makeItem(), SEED_AVATARS, { ownedFileNames: ["Lime_texture.png"] });
    expect(result.owned_versions).toEqual([]);
  });

  it("reports owned versions from purchased variation names, expanding full sets", () => {
    const item = makeItem({ variations: ["Fullset", "しなの - Shinano", "桔梗用 - Kikyo"] });
    expect(extractCompatibility(item, SEED_AVATARS, { ownedVariationNames: ["桔梗用 - Kikyo"] }).owned_versions).toEqual([
      { avatar: "kikyo", evidence: "桔梗用 - Kikyo" },
    ]);
    const full = extractCompatibility(item, SEED_AVATARS, { ownedVariationNames: ["Fullset"] });
    expect(full.owned_versions.map((o) => o.avatar).sort()).toEqual(["kikyo", "shinano"]);
  });
});

describe("evidence", () => {
  it("caps evidence at 120 characters around the match", () => {
    const description = `${"説明".repeat(100)}しなのちゃんにも着せられます${"説明".repeat(100)}`;
    const evidence = find(extractCompatibility(makeItem({ description }), SEED_AVATARS), "shinano")?.evidence ?? "";
    expect(evidence.length).toBeLessThanOrEqual(120);
    expect(evidence).toContain("しなの");
  });
});

describe("avatar bodies", () => {
  it("never reports the avatar body as compatible with itself", () => {
    const body = makeItem({ name: "オリジナル3Dモデル「しなの」", categoryId: 208, tags: ["しなの", "VRChat"] });
    const result = extractCompatibility(body, SEED_AVATARS);
    expect(result.self_avatar).toBe("shinano");
    expect(result.compatible_avatars).toEqual([]);
  });
});

describe("checkCompatibility", () => {
  const item = makeItem({ tags: ["しなの対応"], description: "桔梗には非対応です" });

  it("resolves ids and any alias", () => {
    for (const query of ["shinano", "しなの", "シナノ", "SHINANO", "しなのちゃん"]) {
      expect(checkCompatibility(item, query, SEED_AVATARS)).toMatchObject({
        avatar: "shinano",
        result: "supported",
        confidence: "high",
        evidence: ["しなの対応"],
      });
    }
  });

  it("returns not_supported with evidence", () => {
    expect(checkCompatibility(item, "Kikyo", SEED_AVATARS)).toMatchObject({ result: "not_supported", evidence: ["桔梗には非対応です"] });
  });

  it("returns unknown without evidence when nothing matches", () => {
    const result = checkCompatibility(item, "マヌカ", SEED_AVATARS);
    expect(result).toEqual({ avatar: "manuka", result: "unknown", evidence: [] });
  });

  it("matches avatars missing from the dictionary literally", () => {
    const withUnknown = makeItem({ tags: ["ルキフェル対応"] });
    expect(checkCompatibility(withUnknown, "ルキフェル", SEED_AVATARS)).toMatchObject({ result: "supported", confidence: "high" });
    expect(checkCompatibility(withUnknown, "存在しないアバター", SEED_AVATARS)).toMatchObject({ result: "unknown", evidence: [] });
  });

  it("explains tag-only names in per-avatar variation items", () => {
    const split = makeItem({ variations: ["しなの用", "桔梗用"], tags: ["マヌカ"] });
    const result = checkCompatibility(split, "マヌカ", SEED_AVATARS);
    expect(result.result).toBe("unknown");
    expect(result.evidence).toEqual(["マヌカ"]);
    expect(result.reason).toMatch(/variation/);
  });

  it("answers unknown for the avatar body itself", () => {
    const body = makeItem({ name: "オリジナル3Dモデル「桔梗」", categoryId: 208, tags: ["桔梗"] });
    const result = checkCompatibility(body, "桔梗", SEED_AVATARS);
    expect(result.result).toBe("unknown");
    expect(result.reason).toMatch(/avatar body/);
  });
});
