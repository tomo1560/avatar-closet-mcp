import { BoothError } from "../errors.js";

export const BOOTH_ORIGIN = "https://booth.pm";
export const ACCOUNTS_ORIGIN = "https://accounts.booth.pm";
export const ACCOUNT_SETTINGS_URL = `${ACCOUNTS_ORIGIN}/settings`;

const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([BOOTH_ORIGIN, ACCOUNTS_ORIGIN]);
const ACCOUNTS_HOST = "accounts.booth.pm";
const DOWNLOADABLE_PATH = /^\/downloadables\/\d{1,20}$/u;
const NUMERIC = /^\d{1,20}$/u;

/**
 * Resolves a relative path or absolute URL and enforces the host allowlist BEFORE any request.
 * Only `https://booth.pm` and `https://accounts.booth.pm` are reachable (no other subdomain, scheme,
 * port, or embedded credentials).
 */
export function resolveBoothUrl(pathOrUrl: string, defaultOrigin: string = BOOTH_ORIGIN): URL {
  assertAllowedOrigin(defaultOrigin);
  let url: URL;
  try {
    url = new URL(pathOrUrl, defaultOrigin);
  } catch {
    throw new BoothError("INVALID_INPUT", "URL を解釈できません。");
  }
  if (!isAllowedUrl(url)) {
    throw new BoothError("INVALID_INPUT", `許可されていない宛先です（booth.pm / accounts.booth.pm のみ）: ${url.protocol}//${url.hostname}`);
  }
  return url;
}

export function assertAllowedOrigin(origin: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new BoothError("INVALID_INPUT", "origin を解釈できません。");
  }
  if (!isAllowedUrl(parsed) || parsed.pathname !== "/" || parsed.search !== "") {
    throw new BoothError("INVALID_INPUT", "origin は https://booth.pm か https://accounts.booth.pm のみ指定できます。");
  }
}

function isAllowedUrl(url: URL): boolean {
  return ALLOWED_ORIGINS.has(url.origin) && url.username === "" && url.password === "";
}

/** Pages that only make sense with a signed-in session. */
export function requiresSession(url: URL): boolean {
  return url.hostname === ACCOUNTS_HOST || isDownloadableUrl(url);
}

/** `https://booth.pm/downloadables/{id}` with an optional single `variation_id` query parameter. */
export function isDownloadableUrl(url: URL): boolean {
  if (url.origin !== BOOTH_ORIGIN || url.hash !== "" || !DOWNLOADABLE_PATH.test(url.pathname)) return false;
  const keys = [...url.searchParams.keys()];
  if (keys.length === 0) return true;
  return keys.length === 1 && keys[0] === "variation_id" && NUMERIC.test(url.searchParams.get("variation_id") ?? "");
}

/**
 * True for BOOTH sign-in / OAuth pages and any pixiv host (the OAuth provider).
 * TODO(PLAN §7): verify the exact sign-in paths against the real redirect chain.
 */
export function isSignInUrl(value: string | URL): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host === "pixiv.net" || host.endsWith(".pixiv.net")) return true;
  const segments = url.pathname.split("/").filter(Boolean);
  const usersIndex = segments.indexOf("users");
  if (usersIndex < 0) return false;
  const next = segments[usersIndex + 1];
  return next === "sign_in" || next === "auth";
}
