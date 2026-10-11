import { describe, expect, it } from "vitest";

import {
  findOccurrences,
  isAsciiAlias,
  maskUrls,
  normalizeCompact,
  normalizeText,
  quoteAround,
  tokenize,
} from "../src/vrchat/text.js";

describe("normalizeCompact", () => {
  it("unifies hiragana, katakana, half-width katakana and case", () => {
    // Arrange
    const inputs = ["しなの", "シナノ", "ｼﾅﾉ", "「しなの」"];

    // Act
    const normalized = inputs.map(normalizeCompact);

    // Assert
    expect(new Set(normalized)).toEqual(new Set(["しなの"]));
  });

  it("case-folds and strips spaces and punctuation from latin text", () => {
    expect(normalizeCompact("SHINANO")).toBe("shinano");
    expect(normalizeCompact(" Shi-na no ")).toBe("shinano");
    expect(normalizeCompact("Ｓｈｉｎａｎｏ")).toBe("shinano");
  });

  it("strips latin diacritics but keeps Japanese voiced marks", () => {
    expect(normalizeCompact("Alué")).toBe("alue");
    expect(normalizeCompact("ガブ")).toBe("がぶ");
    expect(normalizeCompact("ｶﾞﾌﾞ")).toBe("がぶ");
  });

  it("keeps the plus sign and the long vowel mark", () => {
    expect(normalizeCompact("+Head")).toBe("+head");
    expect(normalizeCompact("ラシューシャ")).toBe("らしゅーしゃ");
  });

  it("strips Japanese brackets and separators", () => {
    expect(normalizeCompact("【しなの・桔梗用】")).toBe("しなの桔梗用");
  });
});

describe("normalizeText", () => {
  it("maps normalized characters back to original offsets", () => {
    // Arrange
    const original = "【しなの対応】";

    // Act
    const normalized = normalizeText(original);
    const start = normalized.text.indexOf("しなの");

    // Assert
    expect(normalized.starts[start]).toBe(1);
    expect(normalized.ends[start + 2]).toBe(4);
  });

  it("records boundaries where separators were removed", () => {
    const normalized = normalizeText("Kikyo Moe");
    expect(normalized.text).toBe("kikyomoe");
    expect(normalized.boundaries[5]).toBe(true);
    expect(normalized.boundaries[3]).toBe(false);
  });
});

describe("findOccurrences", () => {
  it("requires ASCII word boundaries for latin aliases", () => {
    const text = normalizeText("Kikyo Moe Selestia");
    expect(findOccurrences(text, "moe")).toHaveLength(1);
    expect(findOccurrences(normalizeText("Moeka"), "moe")).toHaveLength(0);
    expect(findOccurrences(normalizeText("unofficial"), "uno")).toHaveLength(0);
    expect(findOccurrences(normalizeText("Shinano用"), "shinano")).toHaveLength(1);
    expect(findOccurrences(normalizeText("Outfit_Shinano_v1.2"), "shinano")).toHaveLength(1);
  });

  it("rejects katakana aliases that continue into a longer katakana word", () => {
    expect(findOccurrences(normalizeText("ミルフィーユ風ドレス"), "みるふぃ")).toHaveLength(0);
    expect(findOccurrences(normalizeText("マヌカハニー"), "まぬか")).toHaveLength(0);
    expect(findOccurrences(normalizeText("ミルフィ用"), "みるふぃ")).toHaveLength(1);
    expect(findOccurrences(normalizeText("しなのちゃんにも"), "しなの")).toHaveLength(1);
  });
});

describe("tokenize", () => {
  it("splits variation names on separators and brackets", () => {
    expect(tokenize("しなの・桔梗用（Shinano・Kikyo）")).toEqual(["しなの", "桔梗用", "shinano", "kikyo"]);
    expect(tokenize("ばつ-Batsu-")).toEqual(["ばつ", "batsu"]);
    expect(tokenize("Nemesis_ELusion")).toEqual(["nemesis", "elusion"]);
    expect(tokenize("MameFriends (Kipfel / Mamehinata)")).toEqual(["mamefriends", "kipfel", "mamehinata"]);
    expect(tokenize("+Head")).toEqual(["+head"]);
  });
});

describe("helpers", () => {
  it("masks URLs and handles without shifting offsets", () => {
    const masked = maskUrls("しなの https://shinano.booth.pm/items/1 @Shinano_x");
    expect(masked).toHaveLength("しなの https://shinano.booth.pm/items/1 @Shinano_x".length);
    expect(masked).not.toContain("shinano");
  });

  it("detects ASCII aliases", () => {
    expect(isAsciiAlias("+head")).toBe(true);
    expect(isAsciiAlias("しなの")).toBe(false);
  });

  it("caps quotes at 120 characters and keeps the match visible", () => {
    // Arrange
    const long = `${"あ".repeat(200)}しなの${"い".repeat(200)}`;

    // Act
    const quote = quoteAround(long, 200, 203);

    // Assert
    expect(quote.length).toBeLessThanOrEqual(120);
    expect(quote).toContain("しなの");
  });

  it("returns short text unchanged apart from trimming", () => {
    expect(quoteAround("  しなの用  ", 2, 5)).toBe("しなの用");
  });
});
