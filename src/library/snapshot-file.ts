import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export type SnapshotTextRead = { status: "missing" } | { status: "unreadable" } | { status: "ok"; text: string };

/** Reads a UTF-8 file. Never throws: only ENOENT counts as missing, any other error as unreadable. */
export async function readSnapshotText(file: string): Promise<SnapshotTextRead> {
  try {
    return { status: "ok", text: await readFile(file, "utf8") };
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { status: "missing" } : { status: "unreadable" };
  }
}

/**
 * Atomically replaces `file` (tmp file in the same directory + rename; file 0o600, directories
 * 0o700 created recursively). On failure the tmp file is removed and an Error is thrown whose
 * message names only `label` and the file system error code: fs messages contain local paths
 * (and thus the user name), which must not reach MCP clients. The original error is the `cause`.
 */
export async function writeFileAtomic(file: string, content: string, label: string): Promise<void> {
  const tmpPath = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true, mode: DIR_MODE });
    await writeFile(tmpPath, content, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    await rename(tmpPath, file);
  } catch (error) {
    // Best-effort cleanup; the original error is what matters to the caller.
    await unlink(tmpPath).catch(() => undefined);
    throw new Error(`${label}を書き込めませんでした（${errorCode(error)}）。`, { cause: error });
  }
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return "unknown error";
}
