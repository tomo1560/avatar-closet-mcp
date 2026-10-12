#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseCliArgs } from "./cli/commands.js";
import { exitCodeFor } from "./cli/exit-codes.js";
import { runCli, type CliDeps } from "./cli/run.js";
import { asBoothError } from "./errors.js";
import { startStdioServer } from "./server.js";
import { BoothService } from "./service.js";

export * from "./index.js";
export { HELP_TEXT, parseCliArgs, type CliCommand } from "./cli/commands.js";
export { EXIT_CODE_HELP, EXIT_CODES, exitCodeFor } from "./cli/exit-codes.js";
export { runCli, type CliDeps, type CliIo } from "./cli/run.js";

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const exitCode = await runMain(args, {
    createService: () => new BoothService(),
    serve: startStdioServer,
    io: { stdout: (text) => void process.stdout.write(text), stderr: (text) => void process.stderr.write(text) },
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}

/**
 * Parses and runs one command and returns the process exit code: 0 on success, 1 for `status` when
 * signed out, otherwise the code for the error (see EXIT_CODES). Errors are printed to stderr.
 */
export async function runMain(args: readonly string[], deps: CliDeps): Promise<number> {
  try {
    return await runCli(parseCliArgs(args), deps);
  } catch (error) {
    deps.io.stderr(`avatar-closet-mcp エラー: ${describeCliError(error)}\n`);
    return exitCodeFor(error);
  }
}

/**
 * Our own BoothError messages are safe to print in full (they may carry a usage line). Anything else is
 * replaced by a generic message (or just its errno code): foreign messages can carry local paths, and
 * Playwright appends a call log that can include request headers (cookies).
 */
export function describeCliError(error: unknown): string {
  const boothError = asBoothError(error);
  return `${boothError.message} [${boothError.code}]`;
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
    process.stderr.write(`avatar-closet-mcp エラー: ${describeCliError(error)}\n`);
    process.exitCode = exitCodeFor(error);
  });
}
