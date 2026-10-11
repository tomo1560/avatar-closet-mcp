#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BoothError } from "./errors.js";
import { startStdioServer } from "./server.js";
import { BoothService } from "./service.js";
import type { AuthStatus, BoothResult, LogoutResult } from "./types.js";

export * from "./index.js";

export type CliCommand =
  | { kind: "serve" }
  | { kind: "login"; timeoutSec?: number }
  | { kind: "status"; json: boolean }
  | { kind: "logout" }
  | { kind: "help" };

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface CliDeps {
  createService: () => BoothService;
  serve: () => Promise<void>;
  io: CliIo;
}

const HELP_TEXT = `booth-library-mcp - BOOTH 購入者向けの非公式・読み取り専用 MCP サーバー / CLI（pixiv・BOOTH とは無関係です）

使い方:
  booth-library-mcp                          stdio MCP サーバーを起動
  booth-library-mcp serve                    同上
  booth-library-mcp login [--timeout <秒>]   専用ブラウザで BOOTH にログイン（30〜1800 秒、既定 600）
  booth-library-mcp status [--json]          ログイン状態を表示（未ログイン時は終了コード 1）
  booth-library-mcp logout                   保存したセッションとログイン用ブラウザプロファイルを削除
  booth-library-mcp help                     このヘルプを表示
`;

export function parseCliArgs(args: readonly string[]): CliCommand {
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
    case "serve":
      assertNoArgs(rest);
      return { kind: "serve" };
    case "login":
      return parseLogin(rest);
    case "status":
      if (rest.length === 1 && rest[0] === "--json") return { kind: "status", json: true };
      assertNoArgs(rest);
      return { kind: "status", json: false };
    case "logout":
      assertNoArgs(rest);
      return { kind: "logout" };
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" };
    default:
      throw new BoothError("INVALID_INPUT", `不明なコマンドです: ${command}（\`booth-library-mcp help\` を参照）`);
  }
}

function parseLogin(rest: readonly string[]): CliCommand {
  if (rest.length === 0) return { kind: "login" };
  const [flag, next] = rest;
  const inline = flag?.startsWith("--timeout=") ? flag.slice("--timeout=".length) : undefined;
  const value = inline ?? (flag === "--timeout" && rest.length === 2 ? next : undefined);
  if (value === undefined || (inline !== undefined && rest.length !== 1)) {
    throw new BoothError("INVALID_INPUT", "使い方: booth-library-mcp login [--timeout <秒>]");
  }
  const timeoutSec = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(timeoutSec)) {
    throw new BoothError("INVALID_INPUT", "--timeout には秒数（整数）を指定してください。");
  }
  return { kind: "login", timeoutSec };
}

function assertNoArgs(rest: readonly string[]): void {
  if (rest.length > 0) throw new BoothError("INVALID_INPUT", `不明な引数です: ${rest.join(" ")}`);
}

/** Runs one CLI command through the shared service layer and returns the process exit code. */
export async function runCli(command: CliCommand, deps: CliDeps): Promise<number> {
  if (command.kind === "help") {
    deps.io.stdout(HELP_TEXT);
    return 0;
  }
  if (command.kind === "serve") {
    await deps.serve();
    return 0;
  }
  const service = deps.createService();
  try {
    if (command.kind === "login") {
      await service.login({ timeoutSec: command.timeoutSec });
      deps.io.stderr("BOOTH へのログインを確認しました。MCP クライアントから利用できます。\n");
      return 0;
    }
    if (command.kind === "status") return printStatus(await service.authStatus(), command.json, deps.io);
    printLogout(await service.logout(), deps.io);
    return 0;
  } finally {
    await service.close();
  }
}

function printStatus(result: BoothResult<AuthStatus>, json: boolean, io: CliIo): number {
  if (json) {
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.data.authenticated) {
    io.stdout(`ログイン済みです${result.data.displayName ? `（${result.data.displayName}）` : ""}。\n`);
  } else {
    io.stdout("未ログインです。`booth-library-mcp login` を実行してください。\n");
  }
  return result.data.authenticated ? 0 : 1;
}

function printLogout(result: BoothResult<LogoutResult>, io: CliIo): void {
  const { sessionFileRemoved, profileDirRemoved, warnings } = result.data;
  io.stdout(sessionFileRemoved ? "保存されたセッションを削除しました。\n" : "保存されたセッションはありませんでした。\n");
  if (profileDirRemoved) io.stdout("ログイン用ブラウザプロファイルを削除しました。\n");
  for (const warning of warnings) io.stderr(`${warning}\n`);
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const exitCode = await runCli(parseCliArgs(args), {
    createService: () => new BoothService(),
    serve: startStdioServer,
    io: { stdout: (text) => void process.stdout.write(text), stderr: (text) => void process.stderr.write(text) },
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message.split("\n", 1)[0] : String(error);
    process.stderr.write(`booth-library-mcp エラー: ${message}\n`);
    process.exitCode = 1;
  });
}
