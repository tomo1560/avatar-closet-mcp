import { describe, expect, it } from "vitest";
import { BoothError, asBoothError, boothErrorCodes, localIoError } from "../src/errors.js";

function errnoError(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`${code}: something failed, open 'C:\\Users\\kakuu-taro\\AppData\\session.json'`), { code, ...extra });
}

describe("asBoothError", () => {
  it("keeps BoothErrors as they are", () => {
    const original = new BoothError("NOT_FOUND", "missing");
    expect(asBoothError(original)).toBe(original);
  });

  it("lists INTERNAL_ERROR as an error code", () => {
    expect(boothErrorCodes).toContain("INTERNAL_ERROR");
  });

  it.each(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"])(
    "maps the network errno %s to NETWORK_ERROR",
    (code) => {
      const mapped = asBoothError(errnoError(code, { syscall: "connect" }), "https://booth.pm/");
      expect(mapped.code).toBe("NETWORK_ERROR");
      expect(mapped.sourceUrl).toBe("https://booth.pm/");
      expect(mapped.message).not.toContain("kakuu-taro");
    },
  );

  it("maps a fetch failure whose cause carries a network errno to NETWORK_ERROR", () => {
    const error = new TypeError("fetch failed", { cause: errnoError("ECONNRESET") });
    expect(asBoothError(error).code).toBe("NETWORK_ERROR");
  });

  it("maps Playwright API errors and timeouts to NETWORK_ERROR without the call log", () => {
    const playwright = new Error("apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:1\nCall log:\n  cookie: secret=do-not-leak");
    const mapped = asBoothError(playwright);
    expect(mapped.code).toBe("NETWORK_ERROR");
    expect(mapped.message).not.toContain("do-not-leak");
    expect(mapped.message).not.toContain("\n");
    const timeout = Object.assign(new Error("Timeout 30000ms exceeded."), { name: "TimeoutError" });
    expect(asBoothError(timeout).code).toBe("NETWORK_ERROR");
  });

  it.each(["EACCES", "ENOENT", "EPERM", "ENOSPC", "EROFS", "EBUSY", "EISDIR", "EMFILE"])(
    "maps the file-system errno %s to INTERNAL_ERROR naming only the code",
    (code) => {
      const mapped = asBoothError(errnoError(code, { syscall: "open", path: "C:\\Users\\kakuu-taro\\x" }));
      expect(mapped.code).toBe("INTERNAL_ERROR");
      expect(mapped.message).toContain(code);
      expect(mapped.message).not.toContain("kakuu-taro");
      expect(mapped.message).not.toContain("\\");
    },
  );

  it("maps a wrapped file-system error (cause) to INTERNAL_ERROR", () => {
    const wrapped = new Error("スナップショットを書き込めませんでした（EACCES）。", { cause: errnoError("EACCES", { syscall: "open" }) });
    const mapped = asBoothError(wrapped);
    expect(mapped.code).toBe("INTERNAL_ERROR");
    expect(mapped.message).toContain("EACCES");
  });

  it("maps anything else to INTERNAL_ERROR with a generic message and no stack", () => {
    const mapped = asBoothError(new TypeError("Cannot read properties of undefined (reading 'x') at C:\\Users\\kakuu-taro\\src"));
    expect(mapped.code).toBe("INTERNAL_ERROR");
    expect(mapped.message).not.toContain("kakuu-taro");
    expect(mapped.message).not.toContain("Cannot read");
    expect(asBoothError("a string").code).toBe("INTERNAL_ERROR");
    expect(asBoothError(undefined).code).toBe("INTERNAL_ERROR");
  });

  it("ignores codes that do not look like errno names", () => {
    const odd = Object.assign(new Error("odd"), { code: "C:\\Users\\kakuu-taro" });
    const mapped = asBoothError(odd);
    expect(mapped.code).toBe("INTERNAL_ERROR");
    expect(mapped.message).not.toContain("kakuu-taro");
  });
});

describe("localIoError", () => {
  it("names the errno code only", () => {
    const error = localIoError("EACCES");
    expect(error).toBeInstanceOf(BoothError);
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.message).toContain("EACCES");
  });
});
