import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname } from "node:path";

/** Private files (session cookies, dictionaries, caches): 0600 inside a 0700 directory. */
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

const RENAME_ATTEMPTS = 3;
const RENAME_RETRY_MS = 50;
/** Windows refuses to replace a file another process has open for a short moment. */
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);

/** Thrown by readTextFileCapped. `code` lets callers and asBoothError treat it like an errno error. */
export class FileTooLargeError extends Error {
  readonly code = "EFBIG";

  constructor(readonly maxBytes: number) {
    super(`file is larger than ${maxBytes} bytes`);
    this.name = "FileTooLargeError";
  }
}

export interface TextFile {
  readonly text: string;
  /** Stats of the very file that was read (taken from the open handle). */
  readonly stats: Stats;
}

/**
 * Writes `content` to a fresh, uniquely named temporary file (created exclusively, mode 0600) next to
 * `file` and renames it over `file`, so readers see either the old or the new file, never a partial
 * one. The temporary file is removed on any failure. On Windows chmod only toggles the read-only flag;
 * protection there relies on the per-user profile directory ACL.
 */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: PRIVATE_DIR_MODE });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmp, "wx", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The creation mode is subject to the umask; make 0600 explicit.
    await chmod(tmp, PRIVATE_FILE_MODE).catch(() => undefined);
    await renameWithRetry(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Reads a UTF-8 file, refusing (FileTooLargeError) before reading when it exceeds `maxBytes`. */
export async function readTextFileCapped(file: string, maxBytes?: number): Promise<TextFile> {
  const handle = await open(file, "r");
  try {
    const stats = await handle.stat();
    if (maxBytes !== undefined && stats.size > maxBytes) throw new FileTooLargeError(maxBytes);
    return { text: await handle.readFile("utf8"), stats };
  } finally {
    await handle.close();
  }
}

export function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (process.platform !== "win32" || attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS * attempt));
    }
  }
}
