import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoothReader } from "../src/browser/reader.js";
import { parseCliArgs, runCli, type CliCommand } from "../src/cli.js";
import { BoothError } from "../src/errors.js";
import { BoothService, type BoothServiceOptions } from "../src/service.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("CLI argument parsing", () => {
  it.each([
    [[], { kind: "serve" }],
    [["serve"], { kind: "serve" }],
    [["login"], { kind: "login" }],
    [["login", "--timeout", "120"], { kind: "login", timeoutSec: 120 }],
    [["login", "--timeout=90"], { kind: "login", timeoutSec: 90 }],
    [["status"], { kind: "status", json: false }],
    [["status", "--json"], { kind: "status", json: true }],
    [["logout"], { kind: "logout" }],
    [["help"], { kind: "help" }],
    [["--help"], { kind: "help" }],
    [["-h"], { kind: "help" }],
  ] as Array<[string[], CliCommand]>)("parses %j", (args, expected) => {
    expect(parseCliArgs(args)).toEqual(expected);
  });

  it.each([["bogus"], ["login", "--timeout", "abc"], ["login", "--timeout"], ["status", "--verbose"], ["logout", "now"]])(
    "rejects %j",
    (...args) => {
      expect(() => parseCliArgs(args)).toThrow(BoothError);
    },
  );
});

describe("CLI commands", () => {
  it("status prints a human message and exits 1 when logged out", async () => {
    const { io, out } = captureIo();
    const code = await runCli({ kind: "status", json: false }, deps({}, io));
    expect(code).toBe(1);
    expect(out.stdout.join("")).toContain("未ログイン");
  });

  it("status --json prints the structured result", async () => {
    const { io, out } = captureIo();
    await runCli({ kind: "status", json: true }, deps({}, io));
    expect(JSON.parse(out.stdout.join(""))).toMatchObject({ data: { authenticated: false } });
  });

  it("login passes the timeout to the service", async () => {
    const login = vi.fn(() => Promise.resolve());
    const { io, out } = captureIo();
    const code = await runCli({ kind: "login", timeoutSec: 120 }, deps({ login }, io));
    expect(code).toBe(0);
    expect(login).toHaveBeenCalledWith(120_000);
    expect(out.stderr.join("")).toContain("ログイン");
  });

  it("logout removes the saved session", async () => {
    const appDir = await mkdtemp(join(tmpdir(), "booth-library-mcp-cli-"));
    tempPaths.push(appDir);
    await writeFile(join(appDir, "session.json"), "{}", "utf8");
    const { io, out } = captureIo();
    const code = await runCli({ kind: "logout" }, deps({ env: { BOOTH_MCP_HOME: appDir } }, io));
    expect(code).toBe(0);
    expect(out.stdout.join("")).toContain("削除しました");
  });

  it("help mentions the commands and the unofficial status", async () => {
    const { io, out } = captureIo();
    await runCli({ kind: "help" }, deps({}, io));
    const text = out.stdout.join("");
    for (const word of ["login", "status", "logout", "serve", "非公式"]) expect(text).toContain(word);
  });
});

const loggedOutReader: BoothReader = {
  read: () => Promise.reject(new BoothError("AUTH_REQUIRED", "login required")),
  readJson: () => Promise.reject(new BoothError("AUTH_REQUIRED", "login required")),
  close: () => Promise.resolve(),
};

function deps(options: BoothServiceOptions, io: ReturnType<typeof captureIo>["io"]): Parameters<typeof runCli>[1] {
  return {
    createService: () => new BoothService(loggedOutReader, options),
    serve: () => Promise.reject(new Error("serve must not run in tests")),
    io,
  };
}

function captureIo(): {
  io: { stdout: (text: string) => void; stderr: (text: string) => void };
  out: { stdout: string[]; stderr: string[] };
} {
  const out = { stdout: [] as string[], stderr: [] as string[] };
  return {
    out,
    io: { stdout: (text) => void out.stdout.push(text), stderr: (text) => void out.stderr.push(text) },
  };
}
