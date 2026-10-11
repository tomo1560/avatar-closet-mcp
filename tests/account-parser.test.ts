import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAccountSettings } from "../src/parsers/account.js";

const fixture = readFileSync(fileURLToPath(new URL("./fixtures/account-settings.html", import.meta.url)), "utf8");

describe("account settings parser", () => {
  it("extracts the display name and nothing else (no email)", () => {
    expect(parseAccountSettings(fixture)).toEqual({ displayName: "Fictional Buyer" });
  });

  it("returns no display name when the field is missing instead of failing", () => {
    expect(parseAccountSettings("<main><h1>設定</h1></main>")).toEqual({});
  });

  it("ignores empty or implausibly long values", () => {
    expect(parseAccountSettings('<input name="user[nickname]" value="   ">')).toEqual({});
    expect(parseAccountSettings(`<input name="user[nickname]" value="${"x".repeat(200)}">`)).toEqual({});
  });
});
