/**
 * File-name handling for purchased downloads.
 *
 * Source: Myrkie/BoothDownloader BoothDownloader/src/Web/BoothBatchDownloader.cs names the file
 * `Uri.UnescapeDataString(location.Segments.Last())` (last path segment of the 302 Location); PLAN §2.3
 * records the same. Soloflighter1010/Hoard-Asset-Manager hoard/downloader.py `disposition_name`
 * prefers Content-Disposition `filename*=` then `filename=`, falling back to the URL path.
 * TODO(PLAN §7-4): verify against a real download whether the signed host sends Content-Disposition.
 */

/** Cap in UTF-8 bytes (ext4/APFS allow 255 bytes per name); leaves room for the ".part" suffix. */
export const MAX_FILE_NAME_BYTES = 200;

const MAX_EXTENSION_BYTES = 24;
// C0/C1 controls, DEL, and bidi overrides/isolates that can spoof an extension ("evil‮gpj.exe").
// eslint-disable-next-line no-control-regex -- matching control characters is the point here
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩<>:"/\\|?*]/gu;
const TRAILING_DOTS_SPACES = /[. ]+$/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu;
const EXTENSION = /\.[^.\s]{1,23}$/u;
const PERCENT_ESCAPE = /%[0-9a-f]{2}/iu;
const STAR_PARAM = /(?:^|;)\s*filename\*\s*=\s*"?([\w!#$&+.^`{}~-]*)'[^']*'([^;\s"]*)"?/iu;
const PLAIN_PARAM = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/iu;

/**
 * Returns a single safe path component: directory parts and `..` dropped, control / reserved
 * characters removed, Windows device names prefixed with `_`, length capped by UTF-8 bytes while
 * keeping the extension. Falls back to `fallback` when nothing usable remains.
 */
export function sanitizeFileName(name: string, fallback: string): string {
  const lastComponent = name.normalize("NFC").split(/[\\/]/u).pop() ?? "";
  const cleaned = trimEnds(lastComponent.replace(UNSAFE_CHARS, ""));
  if (cleaned === "") return fallback;
  const capped = capUtf8Bytes(avoidReservedName(cleaned), MAX_FILE_NAME_BYTES);
  return capped === "" ? fallback : capped;
}

function trimEnds(value: string): string {
  return value.trim().replace(TRAILING_DOTS_SPACES, "");
}

function avoidReservedName(name: string): string {
  const stem = (name.split(".", 1)[0] ?? "").trimEnd();
  return WINDOWS_RESERVED.test(stem) ? `_${name}` : name;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function capUtf8Bytes(name: string, maxBytes: number): string {
  if (utf8Length(name) <= maxBytes) return name;
  const extension = EXTENSION.exec(name)?.[0] ?? "";
  const keepExtension = extension !== "" && utf8Length(extension) <= MAX_EXTENSION_BYTES;
  const suffix = keepExtension ? extension : "";
  const stem = keepExtension ? name.slice(0, -extension.length) : name;
  const budget = maxBytes - utf8Length(suffix);
  let used = 0;
  let kept = "";
  for (const codePoint of stem) {
    used += utf8Length(codePoint);
    if (used > budget) break;
    kept += codePoint;
  }
  const trimmed = trimEnds(kept);
  return trimmed === "" ? "" : `${trimmed}${suffix}`;
}

/** File name from a Content-Disposition header (RFC 6266 / RFC 8187 `filename*` preferred), or null. */
export function parseContentDispositionName(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = STAR_PARAM.exec(header);
  const fromStar = star ? decodeExtValue(star[1] ?? "", star[2] ?? "") : null;
  if (fromStar) return fromStar;
  const plain = PLAIN_PARAM.exec(header);
  if (!plain) return null;
  const raw = plain[1] !== undefined ? plain[1].replace(/\\(.)/gu, "$1") : (plain[2] ?? "").trim();
  const decoded = decodeLegacyValue(raw);
  return decoded === "" ? null : decoded;
}

function decodeExtValue(charset: string, encoded: string): string | null {
  if (encoded === "") return null;
  try {
    if (/^iso-8859-1$|^latin1$/iu.test(charset)) return Buffer.from(percentBytes(encoded)).toString("latin1");
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function percentBytes(encoded: string): number[] {
  const out: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === "%" && /^[0-9a-f]{2}$/iu.test(encoded.slice(index + 1, index + 3))) {
      out.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      out.push(encoded.charCodeAt(index) & 0xff);
    }
  }
  return out;
}

/**
 * Plain `filename=` values in the wild are either raw UTF-8 (which fetch exposes as Latin-1
 * code units) or percent-encoded UTF-8. Recover both; otherwise keep the value as-is.
 */
function decodeLegacyValue(value: string): string {
  const recovered = recoverUtf8(value);
  if (!PERCENT_ESCAPE.test(recovered)) return recovered;
  try {
    return decodeURIComponent(recovered);
  } catch {
    return recovered;
  }
}

function recoverUtf8(value: string): string {
  const codes = Array.from(value, (char) => char.codePointAt(0) ?? 0);
  if (!codes.some((code) => code >= 0x80) || codes.some((code) => code > 0xff)) return value;
  const decoded = Buffer.from(value, "latin1").toString("utf8");
  return decoded.includes("�") ? value : decoded;
}

/** URL-decoded last path segment (never the query), or null for a directory-like path. */
export function fileNameFromUrlPath(url: URL): string | null {
  const segment = url.pathname.split("/").pop() ?? "";
  if (segment === "") return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
