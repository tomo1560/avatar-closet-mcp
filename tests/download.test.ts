import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { downloadPurchase } from "../src/booth/download.js";
import { BoothError } from "../src/errors.js";
import {
  BUCKET_SEGMENT,
  SECRET,
  SIGNED,
  SIGNED_NAME,
  bytes,
  captureError,
  chunkedBody,
  cleanupTempRoots,
  enabledConfig,
  expectNoSignedUrl,
  fakeFetch,
  fakeReader,
  fileResponse,
  makeTempRoot,
  redirectResponse,
  type FakeReply,
} from "./download-fakes.js";
import type { RedirectLocation } from "../src/browser/reader.js";

afterEach(cleanupTempRoots);

const EVIL = `https://evil.example.net/${BUCKET_SEGMENT}/f.zip?X-Amz-Signature=${SECRET}`;

async function run(
  replies: readonly FakeReply[],
  options: { redirect?: RedirectLocation | Error; input?: Record<string, string>; env?: Record<string, string> } = {},
) {
  const temp = await makeTempRoot();
  const reader = fakeReader(options.redirect);
  const http = fakeFetch(replies);
  const deps = { redirectReader: reader, fetchImpl: http.fetchImpl, config: enabledConfig(temp.root, options.env) };
  const promise = downloadPurchase(deps, { downloadableId: "42", ...options.input });
  return { temp, reader, http, promise };
}

describe("downloadPurchase: success", () => {
  it("streams the signed file into the destination without cookies", async () => {
    const body = chunkedBody([bytes(3), bytes(4, 0x62), bytes(5, 0x63)]);
    const { temp, reader, http, promise } = await run([fileResponse(body, { "content-length": "12" })]);
    const result = await promise;

    expect(result).toEqual({
      path: join(temp.real, SIGNED_NAME),
      file_name: SIGNED_NAME,
      bytes: 12,
      content_type: "application/zip",
    });
    expect(await readFile(result.path, "utf8")).toBe("aaabbbbccccc");
    expect(await readdir(temp.real)).toEqual([SIGNED_NAME]);
    expect(reader.calls).toEqual(["https://booth.pm/downloadables/42"]);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]?.url).toBe(SIGNED);
    const init = http.calls[0]?.init;
    expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
    const headerNames = Object.keys((init?.headers ?? {}) as Record<string, string>).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain("cookie");
    expect(headerNames).not.toContain("authorization");
    expectNoSignedUrl(result);
  });

  it("passes variation_id to BOOTH", async () => {
    const { reader, promise } = await run([fileResponse("x")], { input: { variationId: "7" } });
    await promise;
    expect(reader.calls).toEqual(["https://booth.pm/downloadables/42?variation_id=7"]);
  });

  it("prefers the Content-Disposition filename* over the URL path", async () => {
    const disposition = "attachment; filename=\"plain.zip\"; filename*=UTF-8''%E8%A1%A3%E8%A3%85.zip";
    const { promise } = await run([fileResponse("x", { "content-disposition": disposition })]);
    expect((await promise).file_name).toBe("衣装.zip");
  });

  it("sanitizes a traversal name taken from the signed URL path", async () => {
    const location = `https://s6.booth.pm/${BUCKET_SEGMENT}/..%2F..%2Fevil.exe?X-Amz-Signature=${SECRET}`;
    const { temp, promise } = await run([fileResponse("x")], { redirect: { status: 302, location } });
    const result = await promise;
    expect(result.file_name).toBe("evil.exe");
    expect(result.path).toBe(join(temp.real, "evil.exe"));
  });

  it("falls back to booth-{id}.bin when no name is available", async () => {
    const location = `https://s6.booth.pm/?X-Amz-Signature=${SECRET}`;
    const { promise } = await run([fileResponse("x")], { redirect: { status: 302, location } });
    expect((await promise).file_name).toBe("booth-42.bin");
  });

  it("follows one further redirect inside the allowlist", async () => {
    const second = `https://s7.booth.pm/${BUCKET_SEGMENT}/Outfit_v2.zip?X-Amz-Signature=${SECRET}`;
    const { http, promise } = await run([redirectResponse(second, 307), fileResponse("data")]);
    const result = await promise;
    expect(result.file_name).toBe("Outfit_v2.zip");
    expect(http.calls.map((call) => call.url)).toEqual([SIGNED, second]);
    expect(http.calls[1]?.init).toMatchObject({ redirect: "manual", credentials: "omit" });
  });

  it("returns a null content_type when the CDN omits it", async () => {
    const { promise } = await run([new Response("x", { status: 200, headers: { "content-type": "" } })]);
    expect((await promise).content_type).toBeNull();
  });
});

describe("downloadPurchase: input validation", () => {
  it.each([
    { downloadableId: "12a" },
    { downloadableId: "../1" },
    { downloadableId: "" },
    { downloadableId: "1".repeat(21) },
    { downloadableId: "1", variationId: "x" },
    { downloadableId: "1", variationId: "1&a=b" },
  ])("rejects %j without any request", async (input) => {
    const temp = await makeTempRoot();
    const reader = fakeReader();
    const http = fakeFetch([]);
    const deps = { redirectReader: reader, fetchImpl: http.fetchImpl, config: enabledConfig(temp.root) };
    expect((await captureError(downloadPurchase(deps, input))).code).toBe("INVALID_INPUT");
    expect(reader.calls).toEqual([]);
    expect(http.calls).toEqual([]);
  });

  it("refuses when download is not enabled", async () => {
    const reader = fakeReader();
    const deps = { redirectReader: reader, fetchImpl: fakeFetch([]).fetchImpl, config: enabledConfig("relative") };
    expect((await captureError(downloadPurchase(deps, { downloadableId: "1" }))).code).toBe("INVALID_INPUT");
    expect(reader.calls).toEqual([]);
  });
});

describe("downloadPurchase: BOOTH redirect", () => {
  it.each<[string, RedirectLocation, string]>([
    ["sign-in redirect", { status: 302, location: `https://booth.pm/users/sign_in?return_to=${SECRET}` }, "AUTH_REQUIRED"],
    ["pixiv redirect", { status: 302, location: `https://accounts.pixiv.net/login?state=${SECRET}` }, "AUTH_REQUIRED"],
    ["200 instead of 302", { status: 200, location: undefined }, "BOOTH_CHANGED"],
    ["302 without Location", { status: 302, location: undefined }, "BOOTH_CHANGED"],
    ["404", { status: 404, location: undefined }, "NOT_FOUND"],
    ["unparsable Location", { status: 302, location: `https://[${SECRET}/x` }, "BOOTH_CHANGED"],
  ])("maps a %s", async (_label, redirect, code) => {
    const { http, promise } = await run([], { redirect });
    const error = await captureError(promise);
    expect(error.code).toBe(code);
    expect(http.calls).toEqual([]);
    expectNoSignedUrl(error);
  });

  it("propagates reader errors", async () => {
    const { promise } = await run([], { redirect: new BoothError("RATE_LIMITED", "busy") });
    expect((await captureError(promise)).code).toBe("RATE_LIMITED");
  });

  it("refuses a disallowed host, naming only the host", async () => {
    const { http, promise } = await run([], { redirect: { status: 302, location: EVIL } });
    const error = await captureError(promise);
    expect(error.code).toBe("BOOTH_CHANGED");
    expect(error.message).toContain("evil.example.net");
    expect(error.message).toContain("BOOTH_MCP_DOWNLOAD_HOSTS");
    expect(error.message).not.toContain("f.zip");
    expect(http.calls).toEqual([]);
    expectNoSignedUrl(error);
  });

  it.each([
    `http://s6.booth.pm/${BUCKET_SEGMENT}/f.zip?X-Amz-Signature=${SECRET}`,
    `https://user:${SECRET}@s6.booth.pm/${BUCKET_SEGMENT}/f.zip`,
    `https://s6.booth.pm:8443/${BUCKET_SEGMENT}/f.zip?X-Amz-Signature=${SECRET}`,
    `https://booth.pm/${BUCKET_SEGMENT}/f.zip?X-Amz-Signature=${SECRET}`,
  ])("refuses %s without fetching", async (location) => {
    const { http, promise } = await run([], { redirect: { status: 302, location } });
    const error = await captureError(promise);
    expect(error.code).toBe("BOOTH_CHANGED");
    expect(http.calls).toEqual([]);
    expectNoSignedUrl(error);
  });

  it("honours a BOOTH_MCP_DOWNLOAD_HOSTS override", async () => {
    const { promise } = await run([fileResponse("x")], {
      redirect: { status: 302, location: EVIL },
      env: { BOOTH_MCP_DOWNLOAD_HOSTS: "evil.example.net" },
    });
    expect((await promise).file_name).toBe("f.zip");
  });
});

describe("downloadPurchase: signed URL fetch", () => {
  it("refuses a second redirect to a disallowed host", async () => {
    const { http, promise } = await run([redirectResponse(EVIL)]);
    const error = await captureError(promise);
    expect(error.code).toBe("BOOTH_CHANGED");
    expect(http.calls).toHaveLength(1);
    expectNoSignedUrl(error);
  });

  it("refuses a second redirect to plain http", async () => {
    const { http, promise } = await run([redirectResponse(`http://s7.booth.pm/${BUCKET_SEGMENT}/f.zip?s=${SECRET}`)]);
    expect((await captureError(promise)).code).toBe("BOOTH_CHANGED");
    expect(http.calls).toHaveLength(1);
  });

  it("refuses more than one further redirect", async () => {
    const hop = (n: number): string => `https://s${n}.booth.pm/${BUCKET_SEGMENT}/f.zip?X-Amz-Signature=${SECRET}`;
    const { http, promise } = await run([redirectResponse(hop(7)), redirectResponse(hop(8)), fileResponse("x")]);
    const error = await captureError(promise);
    expect(error.code).toBe("BOOTH_CHANGED");
    expect(http.calls).toHaveLength(2);
    expectNoSignedUrl(error);
  });

  it.each([
    [403, "NETWORK_ERROR"],
    [404, "NOT_FOUND"],
    [429, "RATE_LIMITED"],
    [500, "NETWORK_ERROR"],
  ])("maps CDN HTTP %i to %s without leaking", async (status, code) => {
    const { temp, promise } = await run([fileResponse(`denied ${SIGNED}`, {}, status)]);
    const error = await captureError(promise);
    expect(error.code).toBe(code);
    expect(error.message).toContain(String(status));
    expectNoSignedUrl(error);
    expect(await readdir(temp.real)).toEqual([]);
  });

  it("wraps fetch rejections without leaking the URL", async () => {
    const { promise } = await run([new TypeError(`fetch failed: ${SIGNED}`)]);
    const error = await captureError(promise);
    expect(error.code).toBe("NETWORK_ERROR");
    expectNoSignedUrl(error);
  });

  it("refuses an HTML page instead of a file", async () => {
    const { temp, promise } = await run([fileResponse("<html>sign in</html>", { "content-type": "text/html; charset=utf-8" })]);
    expect((await captureError(promise)).code).toBe("BOOTH_CHANGED");
    expect(await readdir(temp.real)).toEqual([]);
  });
});
