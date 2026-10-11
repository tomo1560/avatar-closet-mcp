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

  it("publishes the login action and all read-only tools with schemas", async () => {
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
      "booth_get_dashboard",
      "booth_list_items",
      "booth_get_item",
      "booth_list_orders",
      "booth_get_order",
      "booth_get_sales",
      "booth_list_conversations",
      "booth_get_conversation",
      "booth_get_shop_settings",
    ]);
    for (const tool of response.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
      expect(tool.annotations).toMatchObject(
        tool.name === "booth_login"
          ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
          : { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      );
    }
  });
});
