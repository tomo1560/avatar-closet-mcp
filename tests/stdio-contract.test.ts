import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

let client: Client | undefined;

describe("stdio MCP contract", () => {
  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("publishes every buyer tool with schemas and annotations", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/cli.ts"],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    client = new Client({ name: "booth-library-mcp-contract-test", version: "1.0.0" });
    await client.connect(transport);
    expect(client.getServerVersion()).toMatchObject({ name: "booth-library-mcp", version: packageVersion });
    const response = await client.listTools();
    expect(response.tools.map((tool) => tool.name)).toEqual([
      "booth_login",
      "booth_auth_status",
      "booth_logout",
      "booth_get_item",
      "booth_search_items",
      "booth_suggest_tags",
      "booth_check_compatibility",
      "booth_search_for_avatar",
      "booth_list_library",
      "booth_list_gifts",
      "booth_list_orders",
      "booth_get_order",
      "booth_list_my_avatars",
      "booth_sync_library_metadata",
    ]);
    const expectedAnnotations: Record<string, object> = {
      booth_login: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      booth_logout: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    };
    for (const tool of response.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.annotations).toMatchObject(
        expectedAnnotations[tool.name] ?? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      );
    }
    const inputs = Object.fromEntries(response.tools.map((tool) => [tool.name, Object.keys(tool.inputSchema.properties ?? {})]));
    expect(inputs).toMatchObject({
      booth_login: ["timeout_sec"],
      booth_get_item: ["item", "include_vrchat"],
      booth_search_items: ["query", "category", "tags", "sort", "page", "only_free", "adult"],
      booth_suggest_tags: ["term"],
      booth_check_compatibility: ["item", "avatar"],
      booth_search_for_avatar: ["avatar", "kind", "query", "page"],
      booth_list_library: ["page", "all", "query", "avatar", "kind", "dependency"],
      booth_list_gifts: ["page", "all", "query", "avatar", "kind", "dependency"],
      booth_list_orders: ["page"],
      booth_get_order: ["order_id"],
      booth_list_my_avatars: [],
      booth_sync_library_metadata: ["max_items"],
    });
    for (const tool of response.tools.filter((entry) => !["booth_login", "booth_auth_status", "booth_logout"].includes(entry.name))) {
      expect(tool.description).toContain("非公式");
    }
  });
});
