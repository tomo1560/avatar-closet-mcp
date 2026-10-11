#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseCliArgs } from "./cli/commands.js";
import { runCli } from "./cli/run.js";
import { BoothError } from "./errors.js";
import { startStdioServer } from "./server.js";
import { BoothService } from "./service.js";

export * from "./index.js";
export { HELP_TEXT, parseCliArgs, type CliCommand } from "./cli/commands.js";
export { runCli, type CliDeps, type CliIo } from "./cli/run.js";

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const exitCode = await runCli(parseCliArgs(args), {
    createService: () => new BoothService(),
    serve: startStdioServer,
    io: { stdout: (text) => void process.stdout.write(text), stderr: (text) => void process.stderr.write(text) },
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}

/**
 * Our own BoothError messages are safe to print in full (they may carry a usage line). Anything else is
 * cut to its first line: Playwright appends a call log that can include request headers (cookies).
 */
export function describeCliError(error: unknown): string {
  if (error instanceof BoothError) return `${error.message} [${error.code}]`;
  return error instanceof Error ? (error.message.split("\n", 1)[0] ?? "") : String(error);
}

/** URL of the script Node was started with, or "" (REPL, `-e`, or a path that does not exist). */
function invokedScriptUrl(): string {
  const script = process.argv[1];
  if (!script) return "";
  try {
    return pathToFileURL(realpathSync(script)).href;
  } catch {
    return "";
  }
}

if (import.meta.url === invokedScriptUrl()) {
  main().catch((error: unknown) => {
    process.stderr.write(`booth-library-mcp エラー: ${describeCliError(error)}\n`);
    process.exitCode = 1;
  });
}
