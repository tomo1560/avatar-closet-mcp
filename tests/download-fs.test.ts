import { writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadPurchase } from "../src/booth/download.js";
import {
  SIGNED,
  SIGNED_NAME,
  bytes,
  captureError,
  chunkedBody,
  cleanupTempRoots,
  enabledConfig,
  expectNoSignedUrl,
  failingBody,
  fakeFetch,
  fakeReader,
  fileResponse,
  makeTempRoot,
  type FakeReply,
  type TempRoot,
} from "./download-fakes.js";

afterEach(cleanupTempRoots);

interface RunOptions {
  readonly env?: Record<string, string>;
  readonly destDir?: string;
  readonly temp?: TempRoot;
}

async function run(replies: readonly FakeReply[], options: RunOptions = {}) {
  const temp = options.temp ?? (await makeTempRoot());
  const reader = fakeReader();
  const http = fakeFetch(replies);
  const deps = { redirectReader: reader, fetchImpl: http.fetchImpl, config: enabledConfig(temp.root, options.env) };
  const input = options.destDir === undefined ? { downloadableId: "42" } : { downloadableId: "42", destDir: options.destDir };
  return { temp, reader, http, promise: downloadPurchase(deps, input) };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("downloadPurchase: never overwrites", () => {
  it("refuses when the target already exists and keeps it untouched", async () => {
    const temp = await makeTempRoot();
    await writeFile(join(temp.real, SIGNED_NAME), "old");
    const { promise } = await run([fileResponse("new")], { temp });
    const error = await captureError(promise);
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain(SIGNED_NAME);
    expect(await readFile(join(temp.real, SIGNED_NAME), "utf8")).toBe("old");
    expect(await readdir(temp.real)).toEqual([SIGNED_NAME]);
  });

  it("does not overwrite a file that appears while downloading", async () => {
    const temp = await makeTempRoot();
    const target = join(temp.real, SIGNED_NAME);
    const body = chunkedBody([bytes(2), bytes(2)], (index) => {
      if (index === 1) writeFileSync(target, "raced");
    });
    const { promise } = await run([fileResponse(body)], { temp });
    expect((await captureError(promise)).code).toBe("INVALID_INPUT");
    expect(await readFile(target, "utf8")).toBe("raced");
    expect(await readdir(temp.real)).toEqual([SIGNED_NAME]);
  });

  it("refuses a leftover .part without deleting it", async () => {
    const temp = await makeTempRoot();
    const part = join(temp.real, `${SIGNED_NAME}.part`);
    await writeFile(part, "someone else's");
    const { promise } = await run([fileResponse("new")], { temp });
    expect((await captureError(promise)).code).toBe("INVALID_INPUT");
    expect(await readFile(part, "utf8")).toBe("someone else's");
    expect(await exists(join(temp.real, SIGNED_NAME))).toBe(false);
  });
});

describe("downloadPurchase: size limits and stream failures", () => {
  const limit = { BOOTH_MCP_DOWNLOAD_MAX_BYTES: "10" };

  it("rejects a Content-Length above maxBytes before writing anything", async () => {
    const { temp, promise } = await run([fileResponse(bytes(11), { "content-length": "11" })], { env: limit });
    const error = await captureError(promise);
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("BOOTH_MCP_DOWNLOAD_MAX_BYTES");
    expect(await readdir(temp.real)).toEqual([]);
  });

  it("aborts mid-stream past maxBytes and removes the .part", async () => {
    const body = chunkedBody([bytes(6), bytes(6), bytes(6)]);
    const { temp, promise } = await run([fileResponse(body)], { env: limit });
    expect((await captureError(promise)).code).toBe("INVALID_INPUT");
    expect(await readdir(temp.real)).toEqual([]);
  });

  it("accepts a file of exactly maxBytes", async () => {
    const { promise } = await run([fileResponse(chunkedBody([bytes(4), bytes(6)]))], { env: limit });
    expect((await promise).bytes).toBe(10);
  });

  it("removes the .part when the body is shorter than Content-Length", async () => {
    const { temp, promise } = await run([fileResponse(bytes(5), { "content-length": "9" })]);
    const error = await captureError(promise);
    expect(error.code).toBe("NETWORK_ERROR");
    expect(await readdir(temp.real)).toEqual([]);
  });

  it("removes the .part and does not leak when the stream fails", async () => {
    const body = failingBody(bytes(3), new TypeError(`terminated while reading ${SIGNED}`));
    const { temp, promise } = await run([fileResponse(body)]);
    const error = await captureError(promise);
    expect(error.code).toBe("NETWORK_ERROR");
    expectNoSignedUrl(error);
    expect(await readdir(temp.real)).toEqual([]);
  });

  it("does not leak in a size-limit error", async () => {
    const { promise } = await run([fileResponse(chunkedBody([bytes(11)]))], { env: limit });
    expectNoSignedUrl(await captureError(promise));
  });

  it("writes an empty body as a zero-byte file", async () => {
    const { promise } = await run([fileResponse(null)]);
    const result = await promise;
    expect(result.bytes).toBe(0);
    expect((await stat(result.path)).size).toBe(0);
  });
});

describe("downloadPurchase: destination directory", () => {
  it("creates and saves into a sub-directory inside the root", async () => {
    const { temp, promise } = await run([fileResponse("x")], { destDir: "avatars/shinano" });
    const result = await promise;
    expect(result.path).toBe(join(temp.real, "avatars", "shinano", SIGNED_NAME));
    expect(await readFile(result.path, "utf8")).toBe("x");
  });

  it("accepts an absolute destDir inside the root", async () => {
    const temp = await makeTempRoot();
    const { promise } = await run([fileResponse("x")], { temp, destDir: join(temp.root, "abs") });
    expect((await promise).path).toBe(join(temp.real, "abs", SIGNED_NAME));
  });

  it("creates the configured root when it does not exist yet", async () => {
    const temp = await makeTempRoot();
    const nested = join(temp.root, "not", "yet");
    const reader = fakeReader();
    const deps = { redirectReader: reader, fetchImpl: fakeFetch([fileResponse("x")]).fetchImpl, config: enabledConfig(nested) };
    const result = await downloadPurchase(deps, { downloadableId: "42" });
    expect(result.path).toBe(join(temp.real, "not", "yet", SIGNED_NAME));
  });

  it.each(["../outside", "sub/../../outside", "..", "a\u0000b"])("refuses destDir %j before any request", async (destDir) => {
    const { reader, promise } = await run([fileResponse("x")], { destDir });
    expect((await captureError(promise)).code).toBe("INVALID_INPUT");
    expect(reader.calls).toEqual([]);
  });

  it("refuses an absolute destDir outside the root", async () => {
    const outside = await makeTempRoot("booth-library-mcp-outside-");
    const { reader, promise } = await run([fileResponse("x")], { destDir: outside.root });
    expect((await captureError(promise)).code).toBe("INVALID_INPUT");
    expect(reader.calls).toEqual([]);
  });

  it("refuses a linked sub-directory that escapes the root, without creating anything outside", async () => {
    const temp = await makeTempRoot();
    const outside = await makeTempRoot("booth-library-mcp-outside-");
    // "junction" needs no privileges on Windows; the type is ignored elsewhere.
    await symlink(outside.real, join(temp.real, "link"), "junction");
    for (const destDir of ["link", join("link", "new")]) {
      const { reader, promise } = await run([fileResponse("x")], { temp, destDir });
      expect((await captureError(promise)).code).toBe("INVALID_INPUT");
      expect(reader.calls).toEqual([]);
    }
    expect(await readdir(outside.real)).toEqual([]);
  });

  it("allows a linked sub-directory that stays inside the root", async () => {
    const temp = await makeTempRoot();
    await mkdir(join(temp.real, "real-sub"));
    await symlink(join(temp.real, "real-sub"), join(temp.real, "alias"), "junction");
    const { promise } = await run([fileResponse("x")], { temp, destDir: "alias" });
    expect((await promise).path).toBe(join(temp.real, "real-sub", SIGNED_NAME));
  });
});
