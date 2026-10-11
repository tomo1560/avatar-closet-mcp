import { describe, expect, it } from "vitest";
import { isItemId, parseItemId, toItemId } from "../src/booth/item-id.js";
import { BoothError } from "../src/errors.js";

function expectInvalid(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(BoothError);
    expect((error as BoothError).code).toBe("INVALID_INPUT");
    return;
  }
  throw new Error("expected INVALID_INPUT");
}

describe("parseItemId", () => {
  it.each([
    [123, "123"],
    ["123", "123"],
    ["  6106863 ", "6106863"],
    ["999999999999", "999999999999"],
    ["https://booth.pm/ja/items/6106863", "6106863"],
    ["https://booth.pm/items/6106863", "6106863"],
    ["https://booth.pm/en/items/6106863", "6106863"],
    ["https://booth.pm/zh-cn/items/6106863", "6106863"],
    ["https://ponderogen.booth.pm/items/6106863", "6106863"],
    ["https://nururori-shop.booth.pm/items/5737352", "5737352"],
    ["https://booth.pm/ja/items/6106863?utm_source=x&page=2", "6106863"],
    ["https://booth.pm/ja/items/6106863#details", "6106863"],
    ["https://booth.pm/ja/items/6106863/", "6106863"],
    ["https://booth.pm/ja/items/6106863.json", "6106863"],
    ["http://booth.pm/ja/items/6106863", "6106863"],
    ["HTTPS://BOOTH.PM/ja/items/6106863", "6106863"],
  ] as const)("accepts %s", (input, expected) => {
    expect(parseItemId(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "0",
    "0123",
    "-5",
    "12a",
    "1.5",
    "1234567890123",
    "javascript:alert(1)",
    "javascript://booth.pm/items/1",
    "file:///C:/items/1",
    "ftp://booth.pm/items/1",
    "https://example.com/items/123",
    "https://booth.pm.evil.com/items/123",
    "https://evilbooth.pm/items/123",
    "https://evil.com/booth.pm/items/123",
    "https://user:pass@booth.pm/items/123",
    "https://booth.pm:8443/items/123",
    "https://a.b.booth.pm/items/123",
    "https://booth.pm/ja/items/abc",
    "https://booth.pm/ja/items/123/edit",
    "https://booth.pm/ja/items/0",
    "https://booth.pm/ja/items/1234567890123",
    "https://booth.pm/ja/browse/3D衣装",
    "https://booth.pm/ja/items",
    "booth.pm/ja/items/123",
    "../../x",
    "x".repeat(3000),
  ])("rejects %j", (input) => {
    expectInvalid(() => parseItemId(input));
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_000_000, Number.MAX_SAFE_INTEGER + 1])(
    "rejects the number %s",
    (input) => {
      expectInvalid(() => parseItemId(input));
    },
  );

  it("rejects non-string, non-number input at runtime", () => {
    expectInvalid(() => parseItemId(null as unknown as string));
  });

  it("keeps the rejected input short in the error message", () => {
    try {
      parseItemId(`https://example.com/${"a".repeat(500)}`);
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(250);
    }
  });
});

describe("toItemId / isItemId", () => {
  it("accepts canonical ids only (no URLs)", () => {
    expect(toItemId("42")).toBe("42");
    expect(toItemId(42)).toBe("42");
    expect(isItemId("42")).toBe(true);
    expect(isItemId("042")).toBe(false);
    expect(isItemId("../../x")).toBe(false);
    expectInvalid(() => toItemId("https://booth.pm/items/42"));
    expectInvalid(() => toItemId("../../x"));
    expectInvalid(() => toItemId(" 42"));
  });
});
