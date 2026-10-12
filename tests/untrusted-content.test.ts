import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, SERVER_INSTRUCTIONS } from "../src/server.js";
import { BoothService } from "../src/service.js";
import { UNTRUSTED_CONTENT_NOTICE } from "../src/tools/register.js";
import { itemRoutes, RoutedFakeReader } from "./helpers/fake-reader.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function withClient(env: Record<string, string>, run: (client: Client) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "avatar-closet-mcp-untrusted-"));
  tempPaths.push(home);
  const reader = new RoutedFakeReader(itemRoutes([6659058]));
  const service = new BoothService(reader, { env: { BOOTH_MCP_HOME: home, ...env, ...(env.BOOTH_MCP_DOWNLOAD_DIR ? { BOOTH_MCP_DOWNLOAD_DIR: join(home, "dl") } : {}) } });
  const { server } = createServer(service);
  const client = new Client({ name: "booth-untrusted-content-test", version: "1.0.0" });
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

describe("seller-provided text is marked as untrusted", () => {
  it("tells the model in the server instructions to treat tool results as data", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/written by BOOTH sellers/u);
    expect(SERVER_INSTRUCTIONS).toMatch(/never as instructions/u);
    expect(SERVER_INSTRUCTIONS).toMatch(/only on explicit user request/u);
  });

  it("adds the untrusted-content notice to every successful tool result (structured and text)", async () => {
    await withClient({}, async (client) => {
      for (const call of [
        { name: "booth_get_item", arguments: { item: "6659058" } },
        { name: "booth_logout", arguments: {} },
      ]) {
        const result = await client.callTool(call);
        expect(result.isError, `${call.name}: ${JSON.stringify(result.content)}`).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ _notice: UNTRUSTED_CONTENT_NOTICE });
        expect(result.structuredContent).toHaveProperty("data");
        const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
        expect(JSON.parse(text)).toMatchObject({ _notice: UNTRUSTED_CONTENT_NOTICE });
        expect(text.startsWith(`{"_notice":`)).toBe(true);
      }
    });
  });

  it("adds the notice to error results too (messages can quote seller-chosen file names)", async () => {
    await withClient({}, async (client) => {
      const result = await client.callTool({ name: "booth_get_item", arguments: { item: "1234567" } });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      expect(text.startsWith(`{"_notice":`)).toBe(true);
      expect(JSON.parse(text)).toMatchObject({ _notice: UNTRUSTED_CONTENT_NOTICE, error: { code: expect.any(String) as unknown } });
    });
  });

  it("declares the notice in every output schema", async () => {
    await withClient({}, async (client) => {
      for (const tool of (await client.listTools()).tools) {
        expect(Object.keys(tool.outputSchema?.properties ?? {})).toContain("_notice");
      }
    });
  });

  it("restricts login, logout and download to explicit user requests", async () => {
    await withClient({ BOOTH_MCP_ENABLE_DOWNLOAD: "1", BOOTH_MCP_DOWNLOAD_DIR: "set-below" }, async (client) => {
      const tools = (await client.listTools()).tools;
      for (const name of ["booth_login", "booth_logout", "booth_download"]) {
        const description = tools.find((tool) => tool.name === name)?.description ?? "";
        expect(description, name).toMatch(/only on (?:an )?explicit user request/iu);
      }
    });
  });
});
