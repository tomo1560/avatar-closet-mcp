import { describe, expect, it } from "vitest";

import { BOOTH_CATEGORY_KINDS, classifyKind, extractAvatarDisplayName, isAvatarBody } from "../src/vrchat/kind.js";

function item(name: string, categoryId: number | null) {
  return { name, category: categoryId === null ? null : { id: categoryId, name: "x" } };
}

describe("classifyKind", () => {
  it.each([
    [209, "costume"],
    [210, "accessory"],
    [214, "other"],
    [215, "tool"],
    [216, "motion"],
    [217, "accessory"],
    [230, "accessory"],
    [999, "other"],
  ] as const)("maps category %i to %s", (categoryId, kind) => {
    expect(classifyKind(item("x", categoryId))).toBe(kind);
  });

  it("returns other without a category", () => {
    expect(classifyKind(item("x", null))).toBe("other");
  });

  it("separates avatar bodies from add-ons in 3Dキャラクター", () => {
    expect(classifyKind(item("オリジナル3Dモデル「しなの」", 208))).toBe("avatar");
    expect(classifyKind(item("【PB対応】オリジナル3Dモデル「セレスティア」", 208))).toBe("avatar");
    expect(classifyKind(item("しなの専用　ロリ化Prefab & 表情16種セット", 208))).toBe("other");
    expect(classifyKind(item("桔梗用 表情ギミック", 208))).toBe("other");
    expect(classifyKind(item("ネコミミ ヘアセット", 208))).toBe("other");
  });

  it("exports the observed category map", () => {
    expect(BOOTH_CATEGORY_KINDS[208]).toEqual({ name: "3Dキャラクター", kind: "avatar" });
    expect(Object.keys(BOOTH_CATEGORY_KINDS).map(Number).sort()).toEqual([208, 209, 210, 214, 215, 216, 217, 230]);
  });
});

describe("avatar body helpers", () => {
  it("is false outside category 208", () => {
    expect(isAvatarBody(item("オリジナル3Dモデル「しなの」", 209))).toBe(false);
  });

  it("extracts the display name", () => {
    expect(extractAvatarDisplayName("オリジナル3Dモデル「桔梗」")).toBe("桔梗");
    expect(extractAvatarDisplayName("オリジナル3Dモデル『ミルティナ』ver1.01.1")).toBe("ミルティナ");
    expect(extractAvatarDisplayName("ライム -Lime- オリジナル3Dモデル ver1.00")).toBe("ライム -Lime-");
    expect(extractAvatarDisplayName("【オリジナル3Dモデル】")).toBeNull();
  });
});
