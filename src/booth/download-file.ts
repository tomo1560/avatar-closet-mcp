import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { BoothError } from "../errors.js";

export interface WriteOptions {
  /** Abort once more than this many bytes arrive (null: no cap). */
  readonly maxBytes: number | null;
  /** Declared length of an un-encoded body; a mismatch means a truncated download. */
  readonly expectedBytes: number | null;
}

const OUTSIDE_ROOT = "保存先は BOOTH_MCP_DOWNLOAD_DIR の内側を指定してください。";

/** True when `candidate` is `root` itself or inside it (both absolute, already normalized). */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * Resolves `requested` (relative to, or absolute inside, `root`), creates it, and returns its real
 * path. Symlinks / junctions are resolved before anything is created, so a link inside the root that
 * points elsewhere is refused without side effects outside the root.
 */
export async function resolveDestinationDir(root: string, requested: string | undefined): Promise<string> {
  if (requested?.includes("\0")) throw outsideRoot();
  const realRoot = await fsStep(async () => {
    await mkdir(root, { recursive: true });
    return realpath(root);
  });
  const rel = relativeInside([root, realRoot], requested ?? "");
  if (rel === null) throw outsideRoot();
  const candidate = join(realRoot, rel);
  const ancestor = await fsStep(async () => realpath(await deepestExisting(candidate, realRoot)));
  if (!isInside(realRoot, ancestor)) throw outsideRoot();
  const real = await fsStep(async () => {
    await mkdir(candidate, { recursive: true });
    return realpath(candidate);
  });
  if (!isInside(realRoot, real)) throw outsideRoot();
  return real;
}

/** Lexical containment against the configured root or its real path (an absolute input may use either). */
function relativeInside(bases: readonly string[], requested: string): string | null {
  for (const base of bases) {
    const lexical = resolve(base, requested);
    if (isInside(base, lexical)) return relative(base, lexical);
  }
  return null;
}

function outsideRoot(): BoothError {
  return new BoothError("INVALID_INPUT", OUTSIDE_ROOT);
}

async function deepestExisting(path: string, stopAt: string): Promise<string> {
  let current = path;
  while (current !== stopAt && !(await pathExists(current))) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** Fails if anything (file, directory, dangling link) already occupies `target`. */
export async function assertTargetAbsent(target: string, fileName: string): Promise<void> {
  if (await fsStep(() => pathExists(target))) throw alreadyExists(fileName);
}

/**
 * Streams `body` into `<target>.part` (created exclusively), then publishes it as `target` without
 * ever replacing an existing file. The `.part` is removed on any failure, but a pre-existing one
 * (another download in progress) is left alone. Returns the byte count.
 */
export async function writeExclusive(
  body: ReadableStream<Uint8Array> | null,
  target: string,
  fileName: string,
  options: WriteOptions,
): Promise<number> {
  const part = `${target}.part`;
  const handle = await openPart(part, fileName);
  try {
    const written = await streamInto(body, handle, options.maxBytes);
    await handle.close();
    if (options.expectedBytes !== null && written !== options.expectedBytes) {
      throw new BoothError("NETWORK_ERROR", `ダウンロードが途中で切れました（${written} / ${options.expectedBytes} バイト）。再実行してください。`);
    }
    await publishNoOverwrite(part, target, fileName);
    return written;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(part, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function openPart(part: string, fileName: string): Promise<FileHandle> {
  try {
    return await open(part, "wx");
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new BoothError("INVALID_INPUT", `一時ファイル「${fileName}.part」が既にあります。別のダウンロード中でなければ削除してから再実行してください。`);
    }
    throw fileSystemError(error);
  }
}

async function streamInto(body: ReadableStream<Uint8Array> | null, handle: FileHandle, maxBytes: number | null): Promise<number> {
  let written = 0;
  const counter = new Transform({
    transform(chunk: Uint8Array, _encoding: BufferEncoding, callback: TransformCallback): void {
      written += chunk.byteLength;
      if (maxBytes !== null && written > maxBytes) callback(tooLarge(maxBytes));
      else callback(null, chunk);
    },
  });
  const source = body ? Readable.fromWeb(body as NodeReadableStream<Uint8Array>) : Readable.from([]);
  try {
    // The write stream closes the handle when it finishes or is destroyed (pipeline waits for 'close').
    await pipeline(source, counter, handle.createWriteStream());
  } catch (error) {
    throw streamError(error);
  }
  return written;
}

/** link() fails with EEXIST instead of replacing (rename() would overwrite on every platform). */
async function publishNoOverwrite(part: string, target: string, fileName: string): Promise<void> {
  try {
    await link(part, target);
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw alreadyExists(fileName);
    // No hard links (e.g. FAT/exFAT): copy, still refusing to replace.
    await copyNoOverwrite(part, target, fileName);
  }
  // The file is already published: a leftover .part must not turn success into an error.
  await rm(part, { force: true }).catch(() => undefined);
}

async function copyNoOverwrite(part: string, target: string, fileName: string): Promise<void> {
  try {
    await copyFile(part, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw alreadyExists(fileName);
    await rm(target, { force: true }).catch(() => undefined);
    throw fileSystemError(error);
  }
}

export function tooLarge(maxBytes: number): BoothError {
  return new BoothError("INVALID_INPUT", `ファイルサイズが BOOTH_MCP_DOWNLOAD_MAX_BYTES（${maxBytes} バイト）を超えるため中止しました。`);
}

function alreadyExists(fileName: string): BoothError {
  return new BoothError("INVALID_INPUT", `保存先に「${fileName}」が既にあります。上書きはしません（移動・削除するか別の dest_dir を指定してください）。`);
}

async function fsStep<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw fileSystemError(error);
  }
}

function fileSystemError(error: unknown): BoothError {
  if (error instanceof BoothError) return error;
  const code = errorCode(error) ?? "UNKNOWN";
  return new BoothError("INVALID_INPUT", `保存先へのファイル操作に失敗しました（${code}）。権限と空き容量を確認してください。`);
}

/** Network failures while reading the body can carry the signed URL: never reuse their message. */
function streamError(error: unknown): BoothError {
  if (error instanceof BoothError) return error;
  if (isFileSystemError(error)) return fileSystemError(error);
  return new BoothError("NETWORK_ERROR", "ダウンロード中に接続が切れました。再実行してください。");
}

function isFileSystemError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "syscall" in error && typeof errorCode(error) === "string";
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const { code } = error as { code: unknown };
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/u.test(code) ? code : undefined;
}
