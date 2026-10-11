import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { BoothService } from "../src/service.js";
import { libraryHtml } from "./helpers/buyer-html.js";
import { RoutedFakeReader } from "./helpers/fake-reader.js";

const LIBRARY = "https://accounts.booth.pm/library";
const GIFTS = "https://accounts.booth.pm/library/gifts";
const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function withClient(reader: RoutedFakeReader, run: (client: Client) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "booth-library-mcp-update-tools-"));
  tempPaths.push(home);
  const { server, service } = createServer(new BoothService(reader, { env: { BOOTH_MCP_HOME: home } }));
  const client = new Client({ name: "booth-update-tools-test", version: "1.0.0" });
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

const routes = {
  [LIBRARY]: { html: libraryHtml([{ id: 7001, name: "架空衣装", files: [{ id: 11, name: "Outfit_v1.zip" }] }], { page: 1, lastPage: 1 }) },
  [GIFTS]: { html: libraryHtml([], { page: 1, lastPage: 1, path: "/library/gifts" }) },
};

describe("booth_check_updates tool", () => {
  it("is listed after the library tools with honest annotations", async () => {
    await withClient(new RoutedFakeReader(), async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names.indexOf("booth_check_updates")).toBe(names.indexOf("booth_sync_library_metadata") + 1);
      const tool = tools.find((entry) => entry.name === "booth_check_updates");
      expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["item_ids", "avatar"]);
      expect(tool?.description).toContain("前回の確認");
      expect(tool?.description).toContain("非公式");
    });
  });

  it("records a baseline on the first call and compares on the next", async () => {
    await withClient(new RoutedFakeReader(routes), async (client) => {
      const first = await client.callTool({ name: "booth_check_updates", arguments: {} });
      expect(first.isError).not.toBe(true);
      expect(first.structuredContent).toMatchObject({ data: { first_run: true, complete: true, owned_items: 1 }, meta: { sourceUrl: LIBRARY } });
      const second = await client.callTool({ name: "booth_check_updates", arguments: { item_ids: ["7001"] } });
      expect(second.structuredContent).toMatchObject({ data: { first_run: false, unchanged_count: 1, filters: { item_ids: ["7001"] } } });
    });
  });

  it("rejects malformed item ids before any request", async () => {
    const reader = new RoutedFakeReader();
    await withClient(reader, async (client) => {
      const result = await client.callTool({ name: "booth_check_updates", arguments: { item_ids: ["../1"] } });
      expect(result.isError).toBe(true);
      expect(reader.calls).toEqual([]);
    });
  });
});
