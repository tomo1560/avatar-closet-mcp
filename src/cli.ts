#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runInteractiveLogin } from "./browser/client.js";
import { startStdioServer } from "./server.js";

export * from "./index.js";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  if (command === "login") {
    await runInteractiveLogin();
    process.stderr.write("BOOTH 로그인이 확인되었습니다. 이제 MCP 클라이언트를 시작할 수 있습니다.\n");
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`booth-library-mcp - BOOTH 판매자용 읽기 전용 MCP\n\n사용법:\n  booth-library-mcp          stdio MCP 서버 시작\n  booth-library-mcp login    전용 브라우저에서 BOOTH 로그인\n  booth-library-mcp --help   도움말\n`);
    return;
  }
  if (command) throw new Error(`알 수 없는 명령: ${command}`);
  await startStdioServer();
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`booth-library-mcp 오류: ${message}\n`);
    process.exitCode = 1;
  });
}
