import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { getDownloadConfig, type DownloadConfig } from "../src/booth/download.js";
import type { BoothRedirectReader, RedirectLocation } from "../src/browser/reader.js";
import { BoothError } from "../src/errors.js";

/** Fictional signed URL. SECRET and the bucket-like path segment must never leak into errors. */
export const SECRET = "fictional-signature-7f3a9c";
export const BUCKET_SEGMENT = "0123-fictional-bucket";
export const SIGNED_NAME = "Outfit_Fictional_v1.zip";
export const SIGNED = `https://s6.booth.pm/${BUCKET_SEGMENT}/i/42/${SIGNED_NAME}?X-Amz-Signature=${SECRET}&X-Amz-Expires=60`;

export interface FakeReader extends BoothRedirectReader {
  readonly calls: string[];
}

export function fakeReader(result: RedirectLocation | Error = { status: 302, location: SIGNED }): FakeReader {
  const calls: string[] = [];
  return {
    calls,
    getRedirectLocation(url: string): Promise<RedirectLocation> {
      calls.push(url);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
}

export interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

export type FakeReply = Response | Error | (() => Response);

export function fakeFetch(replies: readonly FakeReply[]): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init });
    const reply = replies[calls.length - 1];
    if (reply === undefined) return Promise.reject(new Error("unexpected fetch"));
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(typeof reply === "function" ? reply() : reply);
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls };
}

export function fileResponse(body: BodyInit | null, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/zip", ...headers } });
}

export function redirectResponse(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

/** A body delivered in chunks; `onPull(index)` runs before chunk `index` is produced. */
export function chunkedBody(chunks: readonly Uint8Array[], onPull?: (index: number) => void): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller): void {
      onPull?.(index);
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
}

export function failingBody(first: Uint8Array, error: Error): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller): void {
      if (sent) {
        controller.error(error);
        return;
      }
      sent = true;
      controller.enqueue(first);
    },
  });
}

export function bytes(length: number, fill = 0x61): Uint8Array<ArrayBuffer> {
  return new Uint8Array(length).fill(fill);
}

export interface TempRoot {
  readonly root: string;
  /** realpath of root (macOS /var -> /private/var, Windows short names). */
  readonly real: string;
}

const tempPaths: string[] = [];

export async function makeTempRoot(prefix = "avatar-closet-mcp-download-"): Promise<TempRoot> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(root);
  return { root, real: await realpath(root) };
}

export async function cleanupTempRoots(): Promise<void> {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
}

export function enabledConfig(root: string, extra: Record<string, string> = {}): DownloadConfig {
  return getDownloadConfig({ BOOTH_MCP_ENABLE_DOWNLOAD: "1", BOOTH_MCP_DOWNLOAD_DIR: root, ...extra });
}

export async function captureError(promise: Promise<unknown>): Promise<BoothError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(BoothError);
  return error as BoothError;
}

function leakText(value: unknown): string {
  if (!(value instanceof Error)) return JSON.stringify(value) ?? "";
  const extra = value as Error & { sourceUrl?: unknown; cause?: unknown };
  const cause = extra.cause instanceof Error ? `${extra.cause.message}\n${extra.cause.stack ?? ""}` : JSON.stringify(extra.cause);
  return [
    String(value),
    JSON.stringify(value),
    value.stack ?? "",
    typeof extra.sourceUrl === "string" ? extra.sourceUrl : "",
    cause ?? "",
  ].join("\n");
}

/** Asserts no part of the signed URL beyond the file name is visible in an error or result. */
export function expectNoSignedUrl(value: unknown): void {
  const text = leakText(value);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain("X-Amz");
  expect(text).not.toContain(BUCKET_SEGMENT);
}
