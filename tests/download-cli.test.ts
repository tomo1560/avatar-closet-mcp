import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCliArgs, runCli, type CliCommand } from "../src/cli.js";
import { formatDownload, resolveOutDir } from "../src/cli/print-download.js";
import { BoothError } from "../src/errors.js";
import { BoothService } from "../src/service.js";
import {
  BUCKET_SEGMENT,
  SECRET,
  SIGNED_NAME,
  captureError,
  cleanupTempRoots,
  fakeFetch,
  fakeReader,
  fileResponse,
  makeTempRoot,
  type FakeReply,
} from "./download-fakes.js";
import type { RedirectLocation } from "../src/browser/reader.js";
import { RoutedFakeReader } from "./helpers/fake-reader.js";

afterEach(cleanupTempRoots);

describe("CLI download arguments", () => {
  it.each([
    [["download", "42"], { kind: "download", json: false, downloadableId: "42" }],
    [
      ["download", "42", "--variation", "7", "--out", "./dl", "--json"],
      { kind: "download", json: true, downloadableId: "42", variationId: "7", out: "./dl" },
    ],
    [["download", "--out=C:/x", "99999999999999999999"], { kind: "download", json: false, downloadableId: "99999999999999999999", out: "C:/x" }],
  ] as Array<[string[], CliCommand]>)("parses %j", (args, expected) => {
    expect(parseCliArgs(args)).toEqual(expected);
  });

  it.each([
    ["download"],
    ["download", "abc"],
    ["download", "../42"],
    ["download", "42", "43"],
    ["download", "42", "--variation", "x"],
    ["download", "42", "--variation"],
    ["download", "42", "--out"],
    ["download", "42", "--out", ""],
    ["download", "42", "--yes-download"],
    ["download", "42", "--json=true"],
  ])("rejects %j with the usage line", (...args) => {
    expect(() => parseCliArgs(args)).toThrow(BoothError);
    expect(() => parseCliArgs(args)).toThrow(/使い方: booth-library-mcp download/u);
  });

  it("resolves --out against the working directory", () => {
    const base = resolve("/work");
    expect(resolveOutDir("dl", base)).toBe(join(base, "dl"));
    expect(resolveOutDir(resolve("/abs/out"), base)).toBe(resolve("/abs/out"));
    expect(resolveOutDir(undefined, base)).toBeUndefined();
  });

  it("formats a result line", () => {
    const line = formatDownload({
      data: { path: "/dl/a.zip", file_name: "a.zip", bytes: 12345, content_type: "application/zip" },
      meta: { fetchedAt: "", sourceUrl: "", redactions: [] },
    });
    expect(line).toBe("保存しました: /dl/a.zip（12,345 バイト, application/zip）\n");
  });
});

interface CliRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly reader: ReturnType<typeof fakeReader>;
}

async function runDownload(
  args: string[],
  env: Record<string, string>,
  replies: readonly FakeReply[],
  redirect?: RedirectLocation,
): Promise<CliRun> {
  const reader = fakeReader(redirect);
  const out = { stdout: "", stderr: "" };
  const code = await runCli(parseCliArgs(args), {
    createService: () => new BoothService(new RoutedFakeReader(), { env, redirectReader: reader, downloadFetch: fakeFetch(replies).fetchImpl }),
    serve: () => Promise.reject(new Error("serve must not run in tests")),
    io: { stdout: (text) => void (out.stdout += text), stderr: (text) => void (out.stderr += text) },
  });
  return { code, reader, ...out };
}

describe("CLI download command", () => {
  it("saves into --out, reports progress on stderr and the result on stdout", async () => {
    const temp = await makeTempRoot();
    const env = { BOOTH_MCP_HOME: temp.root, BOOTH_MCP_ENABLE_DOWNLOAD: "1" };
    const run = await runDownload(["download", "42", "--out", join(temp.root, "out")], env, [fileResponse("abc")]);
    const path = join(temp.real, "out", SIGNED_NAME);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("ダウンロード 42 を取得しています");
    expect(run.stdout).toBe(`保存しました: ${path}（3 バイト, application/zip）\n`);
    expect(await readFile(path, "utf8")).toBe("abc");
    for (const text of [run.stdout, run.stderr]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(BUCKET_SEGMENT);
    }
  });

  it("--json prints the tool envelope and uses BOOTH_MCP_DOWNLOAD_DIR without --out", async () => {
    const temp = await makeTempRoot();
    const env = { BOOTH_MCP_HOME: temp.root, BOOTH_MCP_ENABLE_DOWNLOAD: "1", BOOTH_MCP_DOWNLOAD_DIR: join(temp.root, "dl") };
    const run = await runDownload(["download", "42", "--variation", "7", "--json"], env, [fileResponse("abc")]);
    expect(JSON.parse(run.stdout)).toMatchObject({
      data: { path: join(temp.real, "dl", SIGNED_NAME), file_name: SIGNED_NAME, bytes: 3 },
      meta: { sourceUrl: "https://booth.pm/downloadables/42?variation_id=7" },
    });
    expect(run.reader.calls).toEqual(["https://booth.pm/downloadables/42?variation_id=7"]);
    expect(run.stdout).not.toContain(SECRET);
  });

  it("still requires BOOTH_MCP_ENABLE_DOWNLOAD=1 when --out is given", async () => {
    const temp = await makeTempRoot();
    const promise = runDownload(["download", "42", "--out", temp.root], { BOOTH_MCP_HOME: temp.root }, [fileResponse("abc")]);
    const error = await captureError(promise);
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("BOOTH_MCP_ENABLE_DOWNLOAD=1");
  });

  it("propagates a URL-free error for a disallowed host", async () => {
    const temp = await makeTempRoot();
    const env = { BOOTH_MCP_HOME: temp.root, BOOTH_MCP_ENABLE_DOWNLOAD: "1" };
    const location = `https://evil.example.net/${BUCKET_SEGMENT}/f.zip?X-Amz-Signature=${SECRET}`;
    const promise = runDownload(["download", "42", "--out", temp.root], env, [], { status: 302, location });
    const error = await captureError(promise);
    expect(error.code).toBe("BOOTH_CHANGED");
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(SECRET);
  });
});
