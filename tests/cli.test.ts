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
    [["library"], { kind: "library", json: false, query: { all: false } }],
    [
      ["library", "--all", "--page", "2", "--query=Dress", "--avatar", "しなの", "--kind", "costume", "--dependency", "liltoon", "--json"],
      { kind: "library", json: true, query: { all: true, page: 2, query: "Dress", avatar: "しなの", kind: "costume", dependency: "liltoon" } },
    ],
    [["gifts", "--all"], { kind: "gifts", json: false, query: { all: true } }],
    [["orders", "--page", "3"], { kind: "orders", json: false, page: 3 }],
    [["order", "30000001", "--json"], { kind: "order", json: true, orderId: "30000001" }],
    [["item", "https://booth.pm/ja/items/1", "--vrchat"], { kind: "item", json: false, item: "https://booth.pm/ja/items/1", vrchat: true }],
    [
      ["search", "しなの", "水着", "--category", "3D衣装", "--tag", "a", "--tag=b", "--page", "2", "--free"],
      {
        kind: "search",
        json: false,
        params: { query: "しなの 水着", category: "3D衣装", tags: ["a", "b"], page: 2, only_free: true, adult: false },
      },
    ],
    [["search", "x", "--category", "209"], { kind: "search", json: false, params: { query: "x", category: 209, tags: [], only_free: false, adult: false } }],
    [["tags", "しなの"], { kind: "tags", json: false, term: "しなの" }],
    [["compat", "123", "桔梗", "--json"], { kind: "compat", json: true, item: "123", avatar: "桔梗" }],
    [["avatars"], { kind: "avatars", json: false }],
    [["avatars", "init"], { kind: "avatars-init", json: false }],
    [["sync"], { kind: "sync", json: false }],
    [["sync", "--max", "50"], { kind: "sync", json: false, max: 50 }],
  ] as Array<[string[], CliCommand]>)("parses %j", (args, expected) => {
    expect(parseCliArgs(args)).toEqual(expected);
  });

  it.each([
    ["bogus"],
    ["login", "--timeout", "abc"],
    ["login", "--timeout"],
    ["status", "--verbose"],
    ["logout", "now"],
    ["library", "--bogus"],
    ["library", "--kind", "hat"],
    ["library", "--page", "-1"],
    ["library", "--all=yes"],
    ["orders", "--page", "1", "--page", "2"],
    ["order"],
    ["compat", "123"],
    ["avatars", "remove"],
    ["sync", "--max"],
  ])(
    "rejects %j",
    (...args) => {
      expect(() => parseCliArgs(args)).toThrow(BoothError);
    },
  );
});

describe("CLI usage errors", () => {
  it("includes the command usage for unknown flags", () => {
    expect(() => parseCliArgs(["library", "--bogus"])).toThrow(/使い方: avatar-closet-mcp library [--all]/u);
  });
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
    const appDir = await mkdtemp(join(tmpdir(), "avatar-closet-mcp-cli-"));
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
    for (const word of ["login", "status", "logout", "serve", "非公式", "library", "gifts", "orders", "order", "item", "search", "tags", "compat", "avatars init", "sync"]) {
      expect(text).toContain(word);
    }
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
