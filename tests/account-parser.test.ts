import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseAccountSettings } from "../src/parsers/account.js";

// Fictional content in the structure of the real settings page (2026-10-12).
const fixture = readFileSync(fileURLToPath(new URL("./fixtures/account-settings.html", import.meta.url)), "utf8");

describe("account settings parser", () => {
  it("extracts the display name from the header and nothing else", () => {
    expect(parseAccountSettings(fixture)).toEqual({ displayName: "Fictional Buyer" });
  });

  it("prefers the nickname in the current-user JSON", () => {
    const html = fixture.replace('data-user-name="Fictional Buyer"', 'data-user-name="Other Name"');
    expect(parseAccountSettings(html)).toEqual({ displayName: "Fictional Buyer" });
  });

  it("falls back to data-user-name when the JSON is broken or has no nickname", () => {
    const broken = fixture
      .replace(/data-current-user="[^"]*"/u, 'data-current-user="{not json"')
      .replace('data-user-name="Fictional Buyer"', 'data-user-name="  Fictional  Handle "');
    expect(parseAccountSettings(broken)).toEqual({ displayName: "Fictional Handle" });
    const shapeless = fixture
      .replace(/data-current-user="[^"]*"/u, 'data-current-user="{&quot;nickname&quot;:42}"')
      .replace('data-user-name="Fictional Buyer"', 'data-user-name="Fictional Handle"');
    expect(parseAccountSettings(shapeless)).toEqual({ displayName: "Fictional Handle" });
  });

  it("still reads the legacy nickname input of a server-rendered form", () => {
    const html = '<main><form><input name="user[nickname]" value="  Fictional  Buyer  "><input name="user[email]" value="buyer@example.com"></form></main>';
    expect(parseAccountSettings(html)).toEqual({ displayName: "Fictional Buyer" });
  });

  it("returns no display name when the field is missing instead of failing", () => {
    expect(parseAccountSettings("<main><h1>設定</h1></main>")).toEqual({});
  });

  it("ignores empty or implausibly long values", () => {
    expect(parseAccountSettings('<input name="user[nickname]" value="   ">')).toEqual({});
    expect(parseAccountSettings(`<input name="user[nickname]" value="${"x".repeat(200)}">`)).toEqual({});
    expect(parseAccountSettings(`<div id="js-navigation" data-user-name="${"x".repeat(200)}"></div>`)).toEqual({});
  });
});
