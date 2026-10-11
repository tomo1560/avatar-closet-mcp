import type { BoothService } from "../service.js";
import type { AuthStatus, BoothResult, LogoutResult } from "../types.js";
import type { CliCommand } from "./commands.js";
import { HELP_TEXT } from "./commands.js";
import { stripControl } from "./format.js";
import { formatDownload, resolveOutDir } from "./print-download.js";
import { formatCompat, formatItem, formatSearch, formatTags } from "./print-items.js";
import {
  formatAvatarInit,
  formatAvatars,
  formatLibrary,
  formatOrder,
  formatOrders,
  formatSync,
  formatSyncProgress,
} from "./print-library.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface CliDeps {
  createService: () => BoothService;
  serve: () => Promise<void>;
  io: CliIo;
}

type DataCommand = Exclude<CliCommand, { kind: "help" | "serve" | "login" | "status" | "logout" }>;

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
    if (command.kind === "logout") {
      printLogout(await service.logout(), deps.io);
      return 0;
    }
    deps.io.stdout(stripControl(await runDataCommand(command, service, deps.io)));
    return 0;
  } finally {
    await service.close();
  }
}

/** Data commands print a table by default and the tool's JSON envelope with `--json`. */
async function runDataCommand(command: DataCommand, service: BoothService, io: CliIo): Promise<string> {
  const render = <T>(result: BoothResult<T>, format: (value: BoothResult<T>) => string): string =>
    command.json ? `${JSON.stringify(result, null, 2)}\n` : format(result);
  switch (command.kind) {
    case "library":
      return render(await service.listLibrary(command.query), formatLibrary);
    case "gifts":
      return render(await service.listGifts(command.query), formatLibrary);
    case "orders":
      return render(await service.listOrders(command.page), formatOrders);
    case "order":
      return render(await service.getOrder(command.orderId), formatOrder);
    case "item":
      return render(await service.getItem({ item: command.item, includeVrchat: command.vrchat }), formatItem);
    case "search":
      return render(await service.searchItems(command.params), formatSearch);
    case "tags":
      return render(await service.suggestTags(command.term), formatTags);
    case "compat":
      return render(await service.checkCompatibility({ item: command.item, avatar: command.avatar }), formatCompat);
    case "avatars":
      return render(await service.listMyAvatars(), formatAvatars);
    case "avatars-init":
      return render(await service.initAvatarDictionary(), (result) => formatAvatarInit(result, service.avatarsFile));
    case "sync": {
      io.stderr("ライブラリとギフトを読み込んでいます（1 秒に 1 リクエスト）…\n");
      const onProgress = (progress: Parameters<typeof formatSyncProgress>[0]): void => io.stderr(formatSyncProgress(progress));
      return render(await service.syncAllMetadata({ maxItems: command.max, onProgress }), formatSync);
    }
    case "download": {
      const options = { downloadDir: resolveOutDir(command.out) };
      if (service.downloadConfig(options).enabled) io.stderr(`ダウンロード ${command.downloadableId} を取得しています…\n`);
      const input = { downloadable_id: command.downloadableId, variation_id: command.variationId };
      return render(await service.downloadPurchase(input, options), formatDownload);
    }
  }
}

function printStatus(result: BoothResult<AuthStatus>, json: boolean, io: CliIo): number {
  if (json) {
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.data.authenticated) {
    io.stdout(stripControl(`ログイン済みです${result.data.displayName ? `（${result.data.displayName}）` : ""}。\n`));
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
