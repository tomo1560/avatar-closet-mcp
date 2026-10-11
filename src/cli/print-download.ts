import { resolve } from "node:path";
import type { DownloadResult } from "../service.js";
import type { BoothResult } from "../types.js";

/** `--out` overrides BOOTH_MCP_DOWNLOAD_DIR for the CLI only; a relative path is resolved against cwd. */
export function resolveOutDir(out: string | undefined, cwd: string = process.cwd()): string | undefined {
  return out === undefined ? undefined : resolve(cwd, out.trim());
}

export function formatDownload(result: BoothResult<DownloadResult>): string {
  const { path, bytes, content_type } = result.data;
  const type = content_type ? `, ${content_type}` : "";
  return `保存しました: ${path}（${bytes.toLocaleString("ja-JP")} バイト${type}）\n`;
}
