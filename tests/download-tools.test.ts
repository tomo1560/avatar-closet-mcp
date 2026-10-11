import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDownloadConfig } from "../src/booth/download.js";
import { createServer } from "../src/server.js";
import { BoothService } from "../src/service.js";
import { downloadStartupWarning } from "../src/tools/download-tools.js";
import {
  BUCKET_SEGMENT,
  SECRET,
  SIGNED_NAME,
  captureError,
  cleanupTempRoots,
  expectNoSignedUrl,
  fakeFetch,
  fakeReader,
  fileResponse,
  makeTempRoot,
  type FakeReader,
  type FakeReply,
  type TempRoot,
} from "./download-fakes.js";
import { RoutedFakeReader } from "./helpers/fake-reader.js";

afterEach(cleanupTempRoots);

interface Setup {
  readonly temp: TempRoot;
  readonly reader: FakeReader;
  readonly service: BoothService;
}

async function setup(replies: readonly FakeReply[], env: Record<string, string> = {}, reader = fakeReader()): Promise<Setup> {
  const temp = await makeTempRoot();
  const fullEnv = { BOOTH_MCP_HOME: join(temp.root, "home"), BOOTH_MCP_ENABLE_DOWNLOAD: "1", BOOTH_MCP_DOWNLOAD_DIR: join(temp.root, "dl"), ...env };
  const service = new BoothService(new RoutedFakeReader(), {
    env: fullEnv,
    redirectReader: reader,
    downloadFetch: fakeFetch(replies).fetchImpl,
  });
  return { temp, reader, service };
}

async function withClient(service: BoothService, run: (client: Client) => Promise<void>): Promise<void> {
  const { server } = createServer(service);
  const client = new Client({ name: "booth-download-tools-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
    await service.close();
  }
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ text: string }>)[0]?.text ?? "";
}

describe("booth_download registration (opt-in)", () => {
  it.each([
    ["not opted in", { BOOTH_MCP_ENABLE_DOWNLOAD: "" }],
    ["opted in without a directory", { BOOTH_MCP_DOWNLOAD_DIR: "" }],
    ["opted in with a relative directory", { BOOTH_MCP_DOWNLOAD_DIR: "downloads" }],
    ["opted in with an invalid host list", { BOOTH_MCP_DOWNLOAD_HOSTS: "*" }],
  ])("is absent when %s", async (_label, env) => {
    const { service } = await setup([], env);
    await withClient(service, async (client) => {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("booth_download");
      expect(names).toContain("booth_get_order");
    });
  });

  it("is listed with write annotations when enabled", async () => {
    const { service } = await setup([]);
    await withClient(service, async (client) => {
      const tool = (await client.listTools()).tools.find((entry) => entry.name === "booth_download");
      expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["downloadable_id", "variation_id", "dest_subdir"]);
      expect(tool?.description).toContain("非公式");
      expect(tool?.description).toContain("上書き");
    });
  });
});

describe("booth_download tool", () => {
  it("saves the file inside the download directory and returns its metadata only", async () => {
    const { temp, reader, service } = await setup([fileResponse("payload", { "content-length": "7" })]);
    await withClient(service, async (client) => {
      const result = await client.callTool({ name: "booth_download", arguments: { downloadable_id: "42", variation_id: 7, dest_subdir: "shinano" } });
      expect(result.isError).not.toBe(true);
      const path = join(temp.real, "dl", "shinano", SIGNED_NAME);
      expect(result.structuredContent).toMatchObject({
        data: { path, file_name: SIGNED_NAME, bytes: 7, content_type: "application/zip" },
        meta: { sourceUrl: "https://booth.pm/downloadables/42?variation_id=7" },
      });
      expect(await readFile(path, "utf8")).toBe("payload");
      expect(reader.calls).toEqual(["https://booth.pm/downloadables/42?variation_id=7"]);
      expectNoSignedUrl(result);
    });
  });

  it("returns a URL-free error for a disallowed redirect host", async () => {
    const location = `https://evil.example.net/${BUCKET_SEGMENT}/f.zip?X-Amz-Signature=${SECRET}`;
    const { service } = await setup([], {}, fakeReader({ status: 302, location }));
    await withClient(service, async (client) => {
      const result = await client.callTool({ name: "booth_download", arguments: { downloadable_id: "42" } });
      expect(result.isError).toBe(true);
      expect(JSON.parse(textOf(result))).toMatchObject({ error: { code: "BOOTH_CHANGED" } });
      expectNoSignedUrl(result);
    });
  });

  it.each([
    { downloadable_id: "../42" },
    { downloadable_id: "42", variation_id: "x" },
    { downloadable_id: "42", dest_subdir: join(process.cwd(), "abs") },
    { downloadable_id: "42", dest_subdir: "" },
  ])("rejects %j before any request", async (args) => {
    const { reader, service } = await setup([]);
    await withClient(service, async (client) => {
      const result = await client.callTool({ name: "booth_download", arguments: args });
      expect(result.isError).toBe(true);
      expect(reader.calls).toEqual([]);
    });
  });
});

describe("BoothService.downloadPurchase", () => {
  it("refuses when disabled and explains why", async () => {
    const { reader, service } = await setup([], { BOOTH_MCP_DOWNLOAD_DIR: "" });
    const error = await captureError(service.downloadPurchase({ downloadable_id: "42" }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("BOOTH_MCP_ENABLE_DOWNLOAD=1");
    expect(error.message).toContain("BOOTH_MCP_DOWNLOAD_DIR");
    expect(reader.calls).toEqual([]);
  });

  it("refuses an absolute dest_subdir", async () => {
    const { reader, service } = await setup([]);
    const error = await captureError(service.downloadPurchase({ downloadable_id: "42", dest_subdir: join(process.cwd(), "x") }));
    expect(error.message).toContain("dest_subdir");
    expect(reader.calls).toEqual([]);
  });

  it("uses an explicit download directory override (CLI --out)", async () => {
    const { temp, service } = await setup([fileResponse("x")], { BOOTH_MCP_DOWNLOAD_DIR: "" });
    const out = join(temp.root, "out");
    const result = await service.downloadPurchase({ downloadable_id: "42" }, { downloadDir: out });
    expect(result.data.path).toBe(join(temp.real, "out", SIGNED_NAME));
  });

  it("needs a redirect-capable reader", async () => {
    const temp = await makeTempRoot();
    const env = { BOOTH_MCP_HOME: temp.root, BOOTH_MCP_ENABLE_DOWNLOAD: "1", BOOTH_MCP_DOWNLOAD_DIR: temp.root };
    const service = new BoothService(new RoutedFakeReader(), { env });
    expect((await captureError(service.downloadPurchase({ downloadable_id: "42" }))).code).toBe("INVALID_INPUT");
  });
});

describe("downloadStartupWarning", () => {
  it("is silent unless opted in", () => {
    expect(downloadStartupWarning({}, getDownloadConfig({}))).toBeNull();
  });

  it("is silent when the download is enabled", () => {
    const env = { BOOTH_MCP_ENABLE_DOWNLOAD: "1", BOOTH_MCP_DOWNLOAD_DIR: process.cwd() };
    expect(downloadStartupWarning(env, getDownloadConfig(env))).toBeNull();
  });

  it("lists the issues when opted in but misconfigured", () => {
    const env = { BOOTH_MCP_ENABLE_DOWNLOAD: "1", BOOTH_MCP_DOWNLOAD_DIR: "relative", BOOTH_MCP_DOWNLOAD_MAX_BYTES: "lots" };
    const warning = downloadStartupWarning(env, getDownloadConfig(env)) ?? "";
    expect(warning).toContain("booth_download は無効");
    expect(warning).toContain("BOOTH_MCP_DOWNLOAD_DIR");
    expect(warning).toContain("BOOTH_MCP_DOWNLOAD_MAX_BYTES");
    expect(warning).not.toContain("relative");
    expect(warning.endsWith("\n")).toBe(true);
  });
});
