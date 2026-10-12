import { describe, expect, it } from "vitest";
import type { BoothReader } from "../src/browser/reader.js";
import { describeCliError, runMain, type CliDeps } from "../src/cli.js";
import { EXIT_CODE_HELP, EXIT_CODES, exitCodeFor } from "../src/cli/exit-codes.js";
import { BoothError, boothErrorCodes } from "../src/errors.js";
import { BoothService } from "../src/service.js";

describe("exit code table", () => {
  it.each([
    ["INVALID_INPUT", 2],
    ["AUTH_REQUIRED", 3],
    ["NOT_FOUND", 4],
    ["RATE_LIMITED", 5],
    ["NETWORK_ERROR", 6],
    ["BOOTH_CHANGED", 7],
    ["INTERNAL_ERROR", 8],
  ] as const)("maps %s to %i", (code, exit) => {
    expect(exitCodeFor(new BoothError(code, "x"))).toBe(exit);
  });

  it("gives every error code a distinct non-zero exit code other than 1", () => {
    const codes = boothErrorCodes.map((code) => EXIT_CODES[code]);
    expect(new Set(codes).size).toBe(boothErrorCodes.length);
    expect(codes).not.toContain(0);
    expect(codes).not.toContain(1);
  });

  it("maps foreign errors to the internal-error exit code", () => {
    expect(exitCodeFor(new TypeError("boom"))).toBe(8);
    expect(exitCodeFor("boom")).toBe(8);
  });

  it("documents every exit code in the help text", () => {
    for (const exit of [0, 1, 2, 3, 4, 5, 6, 7, 8]) expect(EXIT_CODE_HELP).toMatch(new RegExp(`^\\s+${exit}\\s`, "mu"));
    for (const code of boothErrorCodes) expect(EXIT_CODE_HELP).toContain(code);
  });
});

describe("runMain", () => {
  it("returns 2 and prints the usage line for a usage error", async () => {
    const { deps, out } = captureDeps();
    expect(await runMain(["library", "--bogus"], deps)).toBe(2);
    expect(out.stderr).toContain("[INVALID_INPUT]");
    expect(out.stderr).toContain("使い方");
  });

  it("returns 3 when a data command needs a login", async () => {
    const { deps, out } = captureDeps();
    expect(await runMain(["orders"], deps)).toBe(3);
    expect(out.stderr).toContain("[AUTH_REQUIRED]");
  });

  it("keeps exit code 1 for `status` when logged out", async () => {
    const { deps } = captureDeps();
    expect(await runMain(["status"], deps)).toBe(1);
  });

  it("returns 0 and appends the exit code table to the help", async () => {
    const { deps, out } = captureDeps();
    expect(await runMain(["help"], deps)).toBe(0);
    expect(out.stdout).toContain(EXIT_CODE_HELP);
  });

  it("returns 8 for unexpected errors without printing their message", async () => {
    const { deps, out } = captureDeps({ serve: () => Promise.reject(new Error("EACCES at C:\\Users\\kakuu-taro\\x\nstack")) });
    expect(await runMain(["serve"], deps)).toBe(8);
    expect(out.stderr).toContain("[INTERNAL_ERROR]");
    expect(out.stderr).not.toContain("kakuu-taro");
  });
});

describe("describeCliError", () => {
  it("prints our own messages in full and replaces foreign ones with a generic message", () => {
    expect(describeCliError(new BoothError("INVALID_INPUT", "bad\n使い方: x"))).toBe("bad\n使い方: x [INVALID_INPUT]");
    const foreign = describeCliError(new Error("boom\nCall log: cookie=secret"));
    expect(foreign).toMatch(/\[INTERNAL_ERROR\]$/u);
    expect(foreign).not.toContain("secret");
  });

  it("names only the errno code of a local file error", () => {
    const error = Object.assign(new Error("EACCES: permission denied, open 'C:\\Users\\kakuu-taro\\session.json'"), {
      code: "EACCES",
      syscall: "open",
    });
    const text = describeCliError(error);
    expect(text).toContain("EACCES");
    expect(text).not.toContain("kakuu-taro");
  });
});

const loggedOutReader: BoothReader = {
  read: () => Promise.reject(new BoothError("AUTH_REQUIRED", "login required")),
  readJson: () => Promise.reject(new BoothError("AUTH_REQUIRED", "login required")),
  close: () => Promise.resolve(),
};

function captureDeps(overrides: Partial<CliDeps> = {}): { deps: CliDeps; out: { stdout: string; stderr: string } } {
  const out = { stdout: "", stderr: "" };
  const deps: CliDeps = {
    createService: () => new BoothService(loggedOutReader, { env: { BOOTH_MCP_HOME: "/nonexistent-avatar-closet-mcp-home" } }),
    serve: () => Promise.reject(new Error("serve must not run in tests")),
    io: { stdout: (text) => void (out.stdout += text), stderr: (text) => void (out.stderr += text) },
    ...overrides,
  };
  return { deps, out };
}
