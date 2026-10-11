import { describe, expect, it } from "vitest";
import { isAllowedBoothRequest, isBoothHost } from "../src/browser/read-only-guard.js";
import { redactSensitiveText } from "../src/privacy.js";
import { LOGIN_ANNOTATIONS, LOGOUT_ANNOTATIONS, READ_ONLY_ANNOTATIONS } from "../src/server.js";

describe("read-only security boundary", () => {
  it("recognizes BOOTH hosts without accepting lookalikes", () => {
    expect(isBoothHost("booth.pm")).toBe(true);
    expect(isBoothHost("accounts.booth.pm")).toBe(true);
    expect(isBoothHost("booth.pm.example.com")).toBe(false);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("blocks %s requests to BOOTH", (method) => {
    expect(isAllowedBoothRequest(method, "https://accounts.booth.pm/library")).toBe(false);
  });

  it("allows BOOTH read methods", () => {
    expect(isAllowedBoothRequest("GET", "https://accounts.booth.pm/library")).toBe(true);
    expect(isAllowedBoothRequest("HEAD", "https://booth.pm/ja/items/1.json")).toBe(true);
  });

  it("marks every tool with conservative read-only annotations", () => {
    expect(READ_ONLY_ANNOTATIONS).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("marks login as a non-destructive local state change", () => {
    expect(LOGIN_ANNOTATIONS).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it("marks logout as a destructive, local-only, idempotent action", () => {
    expect(LOGOUT_ANNOTATIONS).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("preserves nicknames while redacting direct contact details", () => {
    const result = redactSensitiveText("buyer-cat test@example.com 090-1234-5678 123-4567");
    expect(result.text).toContain("buyer-cat");
    expect(result.text).not.toContain("test@example.com");
    expect(result.redactions).toEqual(expect.arrayContaining(["email", "phone", "postal_code"]));
  });
});
