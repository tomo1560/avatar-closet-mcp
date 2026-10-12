import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoothError } from "../src/errors.js";
import { createServer } from "../src/server.js";
import { BoothService } from "../src/service.js";
import { UNTRUSTED_CONTENT_NOTICE } from "../src/tools/register.js";
import { libraryHtml } from "./helpers/buyer-html.js";
import { RoutedFakeReader } from "./helpers/fake-reader.js";
import { WISHLIST_NAMES, wishlistItemsJson, wishlistItemsUrl, wishlistNamesJson } from "./helpers/wishlist-json.js";

const FREE = "https://accounts.booth.pm/library/free_downloads";
const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function withClient(reader: RoutedFakeReader, run: (client: Client) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "booth-library-mcp-wishlist-tools-"));
  tempPaths.push(home);
  const { server, service } = createServer(new BoothService(reader, { env: { BOOTH_MCP_HOME: home } }));
  const client = new Client({ name: "booth-wishlist-tools-test", version: "1.0.0" });
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

function errorOf(result: Awaited<ReturnType<Client["callTool"]>>): { code: string } {
  const content = result.content as Array<{ type: string; text: string }>;
  return (JSON.parse(content[0]?.text ?? "{}") as { error: { code: string } }).error;
}

describe("wish-list and free-download MCP tools", () => {
  it("booth_list_wishlist resolves a named list and returns the items with the untrusted-content notice", async () => {
    const reader = new RoutedFakeReader({
      [WISHLIST_NAMES]: { json: wishlistNamesJson([{ code: "K0FAKE01", name: "衣装候補" }]) },
      [wishlistItemsUrl(1, "K0FAKE01")]: {
        json: wishlistItemsJson([{ id: 1000201, name: "架空ワンピース", price: "¥ 2,500~", isSoldOut: true }], { page: 1, totalPages: 1 }),
      },
    });
    await withClient(reader, async (client) => {
      const result = await client.callTool({ name: "booth_list_wishlist", arguments: { list: "衣装候補" } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        _notice: UNTRUSTED_CONTENT_NOTICE,
        data: {
          list: { code: "K0FAKE01", name: "衣装候補" },
          count: 1,
          items: [{ item_id: "1000201", price: "¥ 2,500~", is_sold_out: true, is_vrchat: true }],
        },
        meta: { sourceUrl: wishlistItemsUrl(1, "K0FAKE01") },
      });
    });
  });

  it("booth_list_wishlist_names returns the lists", async () => {
    const reader = new RoutedFakeReader({ [WISHLIST_NAMES]: { json: wishlistNamesJson([{ code: "K0FAKE02", name: "Tools" }]) } });
    await withClient(reader, async (client) => {
      const result = await client.callTool({ name: "booth_list_wishlist_names", arguments: {} });
      expect(result.structuredContent).toMatchObject({ data: { lists: [{ code: "K0FAKE02", name: "Tools" }], count: 1 } });
    });
  });

  it("maps AUTH_REQUIRED and BOOTH_CHANGED to structured tool errors", async () => {
    const reader = new RoutedFakeReader({
      [wishlistItemsUrl(1)]: new BoothError("AUTH_REQUIRED", "BOOTH へのログインが必要です。"),
      [wishlistItemsUrl(2)]: { json: { unexpected: true } },
    });
    await withClient(reader, async (client) => {
      const signedOut = await client.callTool({ name: "booth_list_wishlist", arguments: {} });
      expect(signedOut.isError).toBe(true);
      expect(errorOf(signedOut)).toMatchObject({ code: "AUTH_REQUIRED" });
      const changed = await client.callTool({ name: "booth_list_wishlist", arguments: { page: 2 } });
      expect(errorOf(changed)).toMatchObject({ code: "BOOTH_CHANGED" });
    });
  });

  it("rejects a page above 50 in the input schema without a request", async () => {
    const reader = new RoutedFakeReader();
    await withClient(reader, async (client) => {
      const result = await client.callTool({ name: "booth_list_wishlist", arguments: { page: 51 } });
      expect(result.isError).toBe(true);
      expect(reader.calls).toEqual([]);
    });
  });

  it("booth_list_free_downloads lists the free-downloads tab", async () => {
    const html = libraryHtml([{ id: 1000101, name: "架空フリー素材" }], { page: 1, lastPage: 1, path: "/library/free_downloads" });
    await withClient(new RoutedFakeReader({ [FREE]: { html } }), async (client) => {
      const result = await client.callTool({ name: "booth_list_free_downloads", arguments: {} });
      expect(result.structuredContent).toMatchObject({
        data: { source: "free_downloads", count: 1, items: [{ item_id: "1000101", downloadables: [] }] },
        meta: { sourceUrl: FREE },
      });
    });
  });
});
