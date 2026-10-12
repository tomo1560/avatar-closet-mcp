import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadPurchase, type DownloadConfig } from "../src/booth/download.js";
import {
  SIGNED_NAME,
  bytes,
  captureError,
  cleanupTempRoots,
  enabledConfig,
  expectNoSignedUrl,
  fakeFetch,
  fakeReader,
  fileResponse,
  makeTempRoot,
} from "./download-fakes.js";

afterEach(cleanupTempRoots);

const FAST = { headersTimeoutMs: 50, idleTimeoutMs: 50 } as const;

async function setup(fetchImpl: typeof fetch, overrides: Partial<DownloadConfig> = {}) {
  const temp = await makeTempRoot();
  const reader = fakeReader();
  const config: DownloadConfig = { ...enabledConfig(temp.root), ...overrides };
  return { temp, reader, run: (destDir?: string) => downloadPurchase({ redirectReader: reader, fetchImpl, config }, { downloadableId: "42", destDir }) };
}

/** First chunk arrives, then the server stalls forever (only cancellation ends it). */
function stallingBody(first: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller): Promise<void> | void {
      if (sent) return new Promise<void>(() => undefined);
      sent = true;
      controller.enqueue(first);
    },
  });
}

/** fetch that never answers but honours the abort signal, like the real one. */
const hangingFetch = ((_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
  })) as typeof fetch;

/** fetch that never answers and ignores the abort signal. */
const deafFetch = (() => new Promise<Response>(() => undefined)) as typeof fetch;

describe("downloadPurchase: dest_subdir segments", () => {
  it.each([
    "a:b",
    "CON",
    "sub/NUL",
    "con.txt",
    "CONIN$",
    "x/CONOUT$",
    "trailing.",
    "trailing ",
    "a<b",
    "a/../b",
    "..",
    `bidi${String.fromCharCode(0x202e)}gpj`,
  ])("refuses %j before any request and without creating a directory", async (destDir) => {
    const { temp, reader, run } = await setup(fakeFetch([fileResponse("x")]).fetchImpl);
    const error = await captureError(run(destDir));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("dest_subdir");
    expect(reader.calls).toEqual([]);
    expect(await readdir(temp.real)).toEqual([]);
  });

  it.each([
    ["avatars/shinano", ["avatars", "shinano"]],
    ["衣装/しなの 用", ["衣装", "しなの 用"]],
    ["./a//b/", ["a", "b"]],
  ])("accepts %j", async (destDir, segments) => {
    const { temp, run } = await setup(fakeFetch([fileResponse("x")]).fetchImpl);
    expect((await run(destDir)).path).toBe(join(temp.real, ...segments, SIGNED_NAME));
  });

  it("validates an absolute destDir inside the root by its relative segments", async () => {
    const { temp, run } = await setup(fakeFetch([fileResponse("x")]).fetchImpl);
    expect((await captureError(run(join(temp.root, "ok", "CON")))).code).toBe("INVALID_INPUT");
    expect(await readdir(temp.real)).toEqual([]);
  });
});

describe("downloadPurchase: timeouts", () => {
  it("gives up when the signed host sends no response headers in time", async () => {
    const { temp, run } = await setup(hangingFetch, FAST);
    const error = await captureError(run());
    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.message).toContain("応答");
    expectNoSignedUrl(error);
    expect(await readdir(temp.real)).toEqual([]);
  });

  it("gives up even when fetch ignores the abort signal", async () => {
    const { run } = await setup(deafFetch, FAST);
    expect((await captureError(run())).code).toBe("NETWORK_ERROR");
  });

  it("aborts a stalled body and removes the .part file", async () => {
    const { temp, run } = await setup(fakeFetch([fileResponse(stallingBody(bytes(4)))]).fetchImpl, FAST);
    const error = await captureError(run());
    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.message).toContain("途切れ");
    expectNoSignedUrl(error);
    expect(await readdir(temp.real)).toEqual([]);
  });

  it("does not time out a slow but steady body", async () => {
    // Fake clock (only setTimeout / clearTimeout: streams and fs need the real setImmediate / nextTick). Time moves
    // only when the server "sends" a chunk, so machine load cannot stretch a gap past the idle timeout. Each gap is
    // under half the timeout (a read-ahead of one chunk before the timer is re-armed still fits), while the whole
    // body takes well over it, so the test fails if chunks do not re-arm the idle timer.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const gapMs = Math.floor(FAST.idleTimeoutMs / 2) - 5;
      const chunks = 5;
      let pulls = 0;
      const steady = new ReadableStream<Uint8Array>({
        pull(controller): void {
          vi.advanceTimersByTime(gapMs);
          pulls += 1;
          if (pulls > chunks) controller.close();
          else controller.enqueue(bytes(1));
        },
      });
      const { run } = await setup(fakeFetch([fileResponse(steady)]).fetchImpl, FAST);
      expect((await run()).bytes).toBe(chunks);
      expect(pulls * gapMs).toBeGreaterThan(FAST.idleTimeoutMs * 2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("downloadPurchase: default size cap", () => {
  it("refuses a declared size above the 4 GiB default", async () => {
    const huge = String(4 * 1024 ** 3 + 1);
    const { temp, run } = await setup(fakeFetch([fileResponse(bytes(1), { "content-length": huge })]).fetchImpl);
    const error = await captureError(run());
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("BOOTH_MCP_DOWNLOAD_MAX_BYTES");
    expect(await readdir(temp.real)).toEqual([]);
  });
});
