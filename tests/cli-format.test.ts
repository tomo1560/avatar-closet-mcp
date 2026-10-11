import { describe, expect, it } from "vitest";
import { renderTable, stripControl } from "../src/cli/format.js";

const BIDI_CONTROLS = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c];

describe("stripControl: bidirectional controls", () => {
  it.each(BIDI_CONTROLS.map((code) => [code.toString(16).toUpperCase().padStart(4, "0"), code] as const))(
    "removes U+%s",
    (_label, code) => {
      expect(stripControl(`a${String.fromCharCode(code)}b`)).toBe("ab");
    },
  );

  it("defeats an extension-spoofing override in a seller-controlled file name", () => {
    const spoofed = `Outfit${String.fromCharCode(0x202e)}piz.exe`;
    expect(stripControl(spoofed)).toBe("Outfitpiz.exe");
    expect(renderTable([{ header: "名前" }], [[spoofed]])).not.toContain(String.fromCharCode(0x202e));
  });

  it("keeps ordinary Japanese, Arabic and Hebrew letters", () => {
    expect(stripControl("しなの対応 عربي עברית")).toBe("しなの対応 عربي עברית");
  });
});
