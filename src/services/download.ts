import { isAbsolute } from "node:path";
import { downloadPurchase, type DownloadConfig, type DownloadResult } from "../booth/download.js";
import type { BoothRedirectReader } from "../browser/reader.js";
import { BOOTH_ORIGIN } from "../browser/url-policy.js";
import { BoothError } from "../errors.js";
import type { BoothResult } from "../types.js";
import { assertNumericId, invalidInput, wrap } from "./result.js";

export type { DownloadResult } from "../booth/download.js";

export interface DownloadPurchaseInput {
  readonly downloadable_id: string;
  readonly variation_id?: string | undefined;
  /** Relative sub-directory of BOOTH_MCP_DOWNLOAD_DIR. */
  readonly dest_subdir?: string | undefined;
}

export interface DownloadServiceDeps {
  /** BoothHttpClient in production; undefined when the service was built with a plain BoothReader. */
  readonly redirectReader: BoothRedirectReader | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly config: DownloadConfig;
}

const DISABLED =
  "ダウンロードは無効です（オプトイン機能）。BOOTH_MCP_ENABLE_DOWNLOAD=1 と BOOTH_MCP_DOWNLOAD_DIR（保存先の絶対パス）を設定してください（CLI は --out でも保存先を指定できます）。";

/**
 * Opt-in download of one of the user's own purchased files (PLAN §3 `booth_download`).
 * The result names the local file only; the signed download URL never leaves the core module.
 */
export async function downloadPurchaseFile(deps: DownloadServiceDeps, input: DownloadPurchaseInput): Promise<BoothResult<DownloadResult>> {
  if (!deps.config.enabled) throw new BoothError("INVALID_INPUT", [DISABLED, ...deps.config.issues].join(" "));
  const downloadableId = input.downloadable_id.trim();
  assertNumericId(downloadableId, "ダウンロード");
  const variationId = optionalTrimmed(input.variation_id);
  if (variationId !== undefined) assertNumericId(variationId, "バリエーション");
  const destDir = relativeSubdir(input.dest_subdir);
  if (!deps.redirectReader) throw invalidInput("この構成ではダウンロードを利用できません（BOOTH のリダイレクトを読めるクライアントが必要です）。");
  const result = await downloadPurchase(
    { redirectReader: deps.redirectReader, config: deps.config, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) },
    { downloadableId, variationId, destDir },
  );
  return wrap(result, downloadableUrl(downloadableId, variationId));
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function relativeSubdir(value: string | undefined): string | undefined {
  const subdir = optionalTrimmed(value);
  if (subdir === undefined) return undefined;
  if (isAbsolute(subdir) || subdir.includes("\0")) {
    throw invalidInput("dest_subdir は BOOTH_MCP_DOWNLOAD_DIR からの相対パスで指定してください。");
  }
  return subdir;
}

/** The BOOTH URL the download started from (never the signed URL it redirects to). */
function downloadableUrl(downloadableId: string, variationId: string | undefined): string {
  const query = variationId === undefined ? "" : `?variation_id=${variationId}`;
  return `${BOOTH_ORIGIN}/downloadables/${downloadableId}${query}`;
}
