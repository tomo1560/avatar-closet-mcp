import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoothError } from "../src/errors.js";
import { createServer } from "../src/server.js";
import { BoothService } from "../src/service.js";
import { libraryHtml } from "./helpers/buyer-html.js";
import { itemJsonUrlOf, itemRoutes, RoutedFakeReader } from "./helpers/fake-reader.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function withClient(reader: RoutedFakeReader, run: (client: Client) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "booth-library-mcp-tools-"));
  tempPaths.push(home);
  const { server, service } = createServer(new BoothService(reader, { env: { BOOTH_MCP_HOME: home } }));
  const client = new Client({ name: "booth-buyer-tools-test", version: "1.0.0" });
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

function errorOf(result: Awaited<ReturnType<Client["callTool"]>>): { code: string; message: string } {
  const content = result.content as Array<{ type: string; text: string }>;
  return (JSON.parse(content[0]?.text ?? "{}") as { error: { code: string; message: string } }).error;
}

describe("MCP buyer tools", () => {
  it("booth_get_item returns structured, compact JSON with VRChat info", async () => {
    await withClient(new RoutedFakeReader(itemRoutes([6659058])), async (client) => {
      const result = await client.callTool({ name: "booth_get_item", arguments: { item: "6659058", include_vrchat: true } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        data: { item_id: "6659058", vrchat: { kind: "costume", quest_support: "yes" } },
        meta: { sourceUrl: itemJsonUrlOf(6659058) },
      });
      const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
      expect(text).not.toContain("\n  ");
    });
  });

  it("booth_list_library filters by avatar and reports metadata status", async () => {
    const html = libraryHtml(
      [
        { id: 6289322, name: "【しなの対応】Vigilant Style" },
        { id: 3087170, name: "【無料】lilToon" },
      ],
      { page: 1, lastPage: 1 },
    );
    const reader = new RoutedFakeReader({ "https://accounts.booth.pm/library": { html }, ...itemRoutes([6289322, 3087170]) });
    await withClient(reader, async (client) => {
      const result = await client.callTool({ name: "booth_list_library", arguments: { avatar: "しなの" } });
      expect(result.structuredContent).toMatchObject({
        data: { count: 1, items: [{ item_id: "6289322" }], metadata_pending: 0, filters: { avatar: "しなの" } },
      });
    });
  });

  it("maps BoothError codes to structured tool errors", async () => {
    const reader = new RoutedFakeReader({
      "https://accounts.booth.pm/orders": new BoothError("AUTH_REQUIRED", "BOOTH にログインしていません。"),
    });
    await withClient(reader, async (client) => {
      const result = await client.callTool({ name: "booth_list_orders", arguments: {} });
      expect(result.isError).toBe(true);
      expect(errorOf(result)).toMatchObject({ code: "AUTH_REQUIRED" });
    });
  });

  it("reports invalid service input as INVALID_INPUT", async () => {
    await withClient(new RoutedFakeReader(), async (client) => {
      const result = await client.callTool({ name: "booth_list_library", arguments: { dependency: "unknown-tool" } });
      expect(result.isError).toBe(true);
      expect(errorOf(result).code).toBe("INVALID_INPUT");
    });
  });

  it("rejects schema violations before calling the service", async () => {
    const reader = new RoutedFakeReader();
    await withClient(reader, async (client) => {
      const result = await client.callTool({ name: "booth_search_items", arguments: { query: "x", page: 6 } });
      expect(result.isError).toBe(true);
      const order = await client.callTool({ name: "booth_get_order", arguments: { order_id: "../settings" } });
      expect(order.isError).toBe(true);
      expect(reader.calls).toEqual([]);
    });
  });
});
