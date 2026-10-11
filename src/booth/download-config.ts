import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

/**
 * Hosts the `booth.pm/downloadables/{id}` redirect may point to. Exact host names, or `*.example.com`
 * meaning any proper subdomain of example.com (never the apex itself).
 *
 * Source: 00b7ce/Stashly src-tauri/src/webview.rs `native_download_url_matches` treats `s6.booth.pm`
 * as the signed-response host; tukiminya/omnooth internal/importer/url.go `ValidateDownloadURL`
 * allows only booth.pm / *.booth.pm on every redirect hop (fixture: download.booth.pm with
 * X-Amz-Signature, i.e. an S3-style presigned URL behind a booth.pm name).
 * TODO(PLAN §7-4): verify against a real download (observed host(s), whether it ever leaves *.booth.pm).
 */
export const DEFAULT_DOWNLOAD_HOSTS: readonly string[] = Object.freeze(["*.booth.pm"]);

export interface DownloadConfig {
  /** True only with BOOTH_MCP_ENABLE_DOWNLOAD=1, an absolute BOOTH_MCP_DOWNLOAD_DIR and no invalid setting. */
  readonly enabled: boolean;
  /** Resolved absolute root that every download must stay inside, or null when unset / not absolute. */
  readonly destDir: string | null;
  readonly allowedHosts: readonly string[];
  /** Per-file byte cap, or null for no cap. */
  readonly maxBytes: number | null;
  /** Why an opted-in configuration is disabled (fail closed). Contains no secrets. */
  readonly issues: readonly string[];
}

export type DownloadEnv = Readonly<Record<string, string | undefined>>;

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** At least two DNS labels, lower-case, no trailing dot, no port / path / userinfo. */
const HOST_NAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`, "u");
const MAX_BYTES_DIGITS = /^\d{1,15}$/u;

const hostEntrySchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((entry) => HOST_NAME.test(entry.startsWith("*.") ? entry.slice(2) : entry));

const maxBytesSchema = z
  .string()
  .trim()
  .regex(MAX_BYTES_DIGITS)
  .transform(Number)
  .refine((value) => Number.isSafeInteger(value) && value > 0);

const destDirSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => isAbsolute(value))
  .transform((value) => resolve(value));

interface Parsed<T> {
  readonly value: T;
  readonly issue: string | null;
}

/** Reads the opt-in download settings. Any invalid value disables downloading instead of guessing. */
export function getDownloadConfig(env: DownloadEnv = process.env): DownloadConfig {
  const optedIn = env.BOOTH_MCP_ENABLE_DOWNLOAD === "1";
  const destDir = parseDestDir(env.BOOTH_MCP_DOWNLOAD_DIR, optedIn);
  const hosts = parseHosts(env.BOOTH_MCP_DOWNLOAD_HOSTS);
  const maxBytes = parseMaxBytes(env.BOOTH_MCP_DOWNLOAD_MAX_BYTES);
  const issues = [destDir.issue, hosts.issue, maxBytes.issue].filter((issue): issue is string => issue !== null);
  return Object.freeze({
    enabled: optedIn && destDir.value !== null && issues.length === 0,
    destDir: destDir.value,
    allowedHosts: hosts.value,
    maxBytes: maxBytes.value,
    issues: Object.freeze(issues),
  });
}

function parseDestDir(raw: string | undefined, optedIn: boolean): Parsed<string | null> {
  const parsed = destDirSchema.safeParse(raw ?? "");
  if (parsed.success) return { value: parsed.data, issue: null };
  if (!optedIn) return { value: null, issue: null };
  const issue = raw?.trim()
    ? "BOOTH_MCP_DOWNLOAD_DIR は絶対パスで指定してください。"
    : "BOOTH_MCP_DOWNLOAD_DIR（保存先の絶対パス）が未設定です。";
  return { value: null, issue };
}

function parseHosts(raw: string | undefined): Parsed<readonly string[]> {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) return { value: DEFAULT_DOWNLOAD_HOSTS, issue: null };
  const parsed = z.array(hostEntrySchema).safeParse(entries);
  if (!parsed.success) {
    return {
      value: Object.freeze([]),
      issue: "BOOTH_MCP_DOWNLOAD_HOSTS はホスト名（例: s6.booth.pm）か *.ドメイン（例: *.booth.pm）のカンマ区切りで指定してください。",
    };
  }
  return { value: Object.freeze([...new Set(parsed.data)]), issue: null };
}

function parseMaxBytes(raw: string | undefined): Parsed<number | null> {
  if (raw === undefined || raw.trim() === "") return { value: null, issue: null };
  const parsed = maxBytesSchema.safeParse(raw);
  if (parsed.success) return { value: parsed.data, issue: null };
  return { value: null, issue: "BOOTH_MCP_DOWNLOAD_MAX_BYTES は正の整数（バイト数）で指定してください。" };
}

/**
 * Exact (case-insensitive) match, or `*.suffix` for proper subdomains of suffix. Host names that are
 * not plain DNS names (trailing dot, IPv6 literal, port, userinfo) never match.
 */
export function isAllowedDownloadHost(host: string, allowedHosts: readonly string[]): boolean {
  const normalized = host.toLowerCase();
  if (!HOST_NAME.test(normalized)) return false;
  return allowedHosts.some((rawEntry) => {
    const entry = rawEntry.toLowerCase();
    if (!entry.startsWith("*.")) return normalized === entry;
    return normalized.endsWith(entry.slice(1));
  });
}
