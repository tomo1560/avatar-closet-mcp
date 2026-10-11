import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { DownloadConfig } from "../booth/download.js";
import type { BoothService } from "../service.js";
import { DOWNLOAD_ANNOTATIONS, register, UNOFFICIAL_NOTE } from "./register.js";

const numericId = z.union([z.string().regex(/^\s*\d{1,20}\s*$/u), z.number().int().positive()]);

const downloadInput = {
  downloadable_id: numericId.describe("ダウンロード ID（数字）。booth_get_order / booth_list_library の downloadable_id"),
  variation_id: numericId.optional().describe("バリエーション ID（数字、任意）"),
  dest_subdir: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => !isAbsolute(value.trim()) && !value.includes("\0"), "BOOTH_MCP_DOWNLOAD_DIR からの相対パスで指定してください")
    .optional()
    .describe("保存先のサブフォルダ（BOOTH_MCP_DOWNLOAD_DIR からの相対パス、任意）。外側は指定できません"),
};

const DESCRIPTION =
  "自分が購入した（または受け取った）BOOTH のファイルを 1 つダウンロードして保存し、保存先のパス・ファイル名・サイズを返します。" +
  "オプトイン機能です（BOOTH_MCP_ENABLE_DOWNLOAD=1 と BOOTH_MCP_DOWNLOAD_DIR を設定したときだけ使えます）。" +
  "保存先は BOOTH_MCP_DOWNLOAD_DIR の中だけで、同名のファイルがあれば上書きせずエラーになります。" +
  "自分の購入品専用です。ユーザーが明示的に頼んだときだけ使い、まとめて大量にダウンロードしないでください。" +
  "ログインが必要です（AUTH_REQUIRED のときは booth_login）。" +
  UNOFFICIAL_NOTE;

/** Registered only when the opt-in download configuration is enabled (PLAN §2.4 consequence 4). */
export function registerDownloadTools(server: McpServer, service: BoothService): void {
  register(
    server,
    "booth_download",
    DESCRIPTION,
    downloadInput,
    ({ downloadable_id, variation_id, dest_subdir }) =>
      service.downloadPurchase({
        downloadable_id: String(downloadable_id),
        variation_id: variation_id === undefined ? undefined : String(variation_id),
        dest_subdir,
      }),
    DOWNLOAD_ANNOTATIONS,
  );
}

/**
 * Explains, once at startup, why `booth_download` is missing although BOOTH_MCP_ENABLE_DOWNLOAD=1.
 * `issues` only name environment variables and expected formats (no paths, URLs or secrets).
 */
export function downloadStartupWarning(env: NodeJS.ProcessEnv, config: DownloadConfig): string | null {
  if (env.BOOTH_MCP_ENABLE_DOWNLOAD !== "1" || config.enabled) return null;
  const reasons = config.issues.length > 0 ? config.issues.join(" ") : "設定を確認してください。";
  return `booth-library-mcp: BOOTH_MCP_ENABLE_DOWNLOAD=1 ですが booth_download は無効です。${reasons}\n`;
}
