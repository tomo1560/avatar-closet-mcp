import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

let client: Client | undefined;
const tempPaths: string[] = [];

/** Starts the real stdio server. Only `env` (plus the SDK's safe defaults) reaches the child process. */
async function connect(env: Record<string, string> = {}): Promise<{ client: Client; stderr: () => string }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/cli.ts"],
    cwd: process.cwd(),
    env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => void (stderr += chunk.toString("utf8")));
  const connected = new Client({ name: "booth-library-mcp-contract-test", version: "1.0.0" });
  client = connected;
  await connected.connect(transport);
  return { client: connected, stderr: () => stderr };
}

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "booth-library-mcp-stdio-"));
  tempPaths.push(home);
  return home;
}

describe("stdio MCP contract", () => {
  afterEach(async () => {
    await client?.close();
    client = undefined;
    await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
  });

  it("publishes every buyer tool (15) with schemas and annotations (booth_download is opt-in and absent)", async () => {
    const { client } = await connect();
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
      "booth_check_updates",
    ]);
    const expectedAnnotations: Record<string, object> = {
      booth_login: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      booth_check_updates: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
      booth_check_updates: ["item_ids", "avatar"],
    });
    for (const tool of response.tools.filter((entry) => !["booth_login", "booth_auth_status", "booth_logout"].includes(entry.name))) {
      expect(tool.description).toContain("非公式");
    }
  });

  it("publishes booth_download only when the download opt-in is configured", async () => {
    const home = await tempHome();
    const { client, stderr } = await connect({
      BOOTH_MCP_HOME: home,
      BOOTH_MCP_ENABLE_DOWNLOAD: "1",
      BOOTH_MCP_DOWNLOAD_DIR: join(home, "downloads"),
    });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(16);
    const tool = tools.find((entry) => entry.name === "booth_download");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["downloadable_id", "variation_id", "dest_subdir"]);
    expect(tool?.outputSchema?.type).toBe("object");
    expect(tool?.description).toContain("非公式");
    expect(stderr()).not.toContain("booth_download");
  });

  it("explains on stderr why booth_download is missing when the opt-in is misconfigured", async () => {
    const home = await tempHome();
    const { client, stderr } = await connect({ BOOTH_MCP_HOME: home, BOOTH_MCP_ENABLE_DOWNLOAD: "1" });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain("booth_download");
    expect(stderr()).toContain("booth_download は無効");
    expect(stderr()).toContain("BOOTH_MCP_DOWNLOAD_DIR");
  });
});
