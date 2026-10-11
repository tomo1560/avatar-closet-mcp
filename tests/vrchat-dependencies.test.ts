import { describe, expect, it } from "vitest";

import { extractDependencies } from "../src/vrchat/dependencies.js";
import type { VrchatItemInput } from "../src/vrchat/types.js";

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

function ids(item: VrchatItemInput): string[] {
  return extractDependencies(item).dependencies.map((d) => d.id).sort();
}

describe("extractDependencies", () => {
  it("detects shaders and tools with evidence and source", () => {
    const item = makeItem({
      name: "【VRCFury対応】ドレス",
      description: "シェーダーはlilToon / Poiyomi / UTS2に対応\nAAOでの最適化推奨\nNDMF, FaceEmo対応",
      tags: ["modularavatar"],
    });
    expect(ids(item)).toEqual(["avatar_optimizer", "faceemo", "liltoon", "modular_avatar", "ndmf", "poiyomi", "uts", "vrcfury"]);
    const result = extractDependencies(item);
    expect(result.dependencies.find((d) => d.id === "modular_avatar")).toMatchObject({ source: "tag", evidence: "modularavatar" });
    expect(result.dependencies.find((d) => d.id === "vrcfury")).toMatchObject({ source: "name", name: "VRCFury" });
  });

  it("guards the MA abbreviation against false positives", () => {
    expect(ids(makeItem({ description: "MA-1ジャケットです。MAYAで制作。ma対応" }))).toEqual([]);
    expect(ids(makeItem({ name: "【MA対応】コート" }))).toEqual(["modular_avatar"]);
    expect(ids(makeItem({ description: "MAで簡単に導入できます" }))).toEqual(["modular_avatar"]);
    expect(ids(makeItem({ tags: ["MA対応"] }))).toEqual(["modular_avatar"]);
  });

  it("maps the ModuleAvatar typo and skips 'not required' mentions", () => {
    expect(ids(makeItem({ description: "AvatarToolsかModuleAvatarを推奨します" }))).toEqual(["modular_avatar"]);
    expect(ids(makeItem({ description: "Modular Avatarは不要です" }))).toEqual([]);
  });

  it("does not report a tool item as depending on itself", () => {
    expect(ids(makeItem({ name: "【無料】lilToon", categoryId: 215 }))).toEqual([]);
    expect(ids(makeItem({ name: "【lilToon対応】影ギミック", categoryId: 215 }))).toEqual(["liltoon"]);
  });

  it("caps evidence length", () => {
    const description = `${"あ".repeat(200)}lilToon${"い".repeat(200)}`;
    const evidence = extractDependencies(makeItem({ description })).dependencies[0]?.evidence ?? "";
    expect(evidence.length).toBeLessThanOrEqual(120);
    expect(evidence).toContain("lilToon");
  });
});

describe("quest_support", () => {
  it.each([
    [{ tags: ["Quest対応"] }, "yes"],
    [{ tags: ["Quest"] }, "yes"],
    [{ description: "Android対応版も同梱" }, "yes"],
    [{ description: "Quest版あり" }, "yes"],
    [{ description: "PC専用です" }, "no"],
    [{ description: "※Quest非対応" }, "no"],
    [{ description: "Questには対応していません" }, "no"],
    [{ tags: ["Android非対応"] }, "no"],
    [{ description: "PhysBone対応" }, "unknown"],
  ] as const)("%o → %s", (overrides, expected) => {
    expect(extractDependencies(makeItem(overrides)).quest_support).toBe(expected);
  });

  it("prefers an explicit 'no' over a free-text 'yes'", () => {
    const result = extractDependencies(makeItem({ description: "Quest対応のアバターでも、本衣装はPC専用です" }));
    expect(result.quest_support).toBe("no");
    expect(result.quest_evidence).toContain("PC専用");
  });

  it("prefers a dedicated Quest variation over a 'no' elsewhere", () => {
    const result = extractDependencies(makeItem({ variations: ["PC版", "Quest対応版"], description: "PC版はPC専用です" }));
    expect(result).toMatchObject({ quest_support: "yes", quest_evidence: "Quest対応版" });
  });

  it("returns null evidence when unknown", () => {
    expect(extractDependencies(makeItem()).quest_evidence).toBeNull();
  });
});
