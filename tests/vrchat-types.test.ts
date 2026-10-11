import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseRawBoothItem } from "../src/booth/item-json.js";
import { classifyKind } from "../src/vrchat/kind.js";
import type { VrchatItemInput } from "../src/vrchat/types.js";

const ITEMS_DIR = join(import.meta.dirname, "fixtures", "public", "items");

describe("VrchatItemInput", () => {
  it("accepts a parsed RawBoothItem without conversion", () => {
    for (const file of readdirSync(ITEMS_DIR)) {
      // Arrange
      const raw = parseRawBoothItem(JSON.parse(readFileSync(join(ITEMS_DIR, file), "utf8")));

      // Act: type-level assignment is the real assertion (checked by `tsc`).
      const input: VrchatItemInput = raw;

      // Assert
      expect(classifyKind(input)).toMatch(/^(avatar|costume|accessory|tool|motion|other)$/);
    }
  });
});
