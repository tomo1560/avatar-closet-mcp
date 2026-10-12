import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const npm = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
const npmArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm"] : [];
const destination = await mkdtemp(join(tmpdir(), "avatar-closet-mcp-package-"));
let client;

try {
  const packed = spawnSync(npm, [...npmArgs, "pack", "--json", "--ignore-scripts", "--pack-destination", destination], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (packed.error) throw packed.error;
  if (packed.status !== 0) throw new Error(packed.stderr || "npm pack failed");

  const archive = resolve(destination, JSON.parse(packed.stdout)[0].filename);
  const installed = spawnSync(
    npm,
    [
      ...npmArgs,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      destination,
      archive,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (installed.error) throw installed.error;
  if (installed.status !== 0) throw new Error(installed.stderr || "npm install failed");

  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const transport = new StdioClientTransport({
    command: resolve(destination, "node_modules", ".bin", process.platform === "win32" ? "avatar-closet-mcp.cmd" : "avatar-closet-mcp"),
    args: [],
    cwd: process.cwd(),
    // A throwaway data directory: never read the real per-user app directory.
    env: { ...getDefaultEnvironment(), BOOTH_MCP_HOME: join(destination, "home") },
    stderr: "pipe",
  });
  transport.stderr?.pipe(process.stderr);
  client = new Client({ name: "avatar-closet-mcp-package-smoke", version: "1.0.0" });
  await client.connect(transport);

  const server = client.getServerVersion();
  if (server?.name !== "avatar-closet-mcp" || server.version !== packageJson.version) {
    throw new Error(`packaged server version mismatch: ${JSON.stringify(server)}`);
  }
  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  const expectedTools = [
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
    "booth_list_free_downloads",
    "booth_list_orders",
    "booth_get_order",
    "booth_list_my_avatars",
    "booth_sync_library_metadata",
    "booth_check_updates",
    "booth_list_wishlist",
    "booth_list_wishlist_names",
  ];
  const missingTools = expectedTools.filter((name) => !toolNames.has(name));
  if (missingTools.length > 0) {
    throw new Error(`packaged server did not expose the expected BOOTH tools: ${missingTools.join(", ")}`);
  }
  if (tools.tools.length !== expectedTools.length) {
    throw new Error(`packaged server exposed ${tools.tools.length} tools, expected ${expectedTools.length}`);
  }
  // booth_download is opt-in (BOOTH_MCP_ENABLE_DOWNLOAD=1 + BOOTH_MCP_DOWNLOAD_DIR); the default environment must not expose it.
  if (toolNames.has("booth_download")) {
    throw new Error("packaged server exposed the opt-in booth_download tool without being enabled");
  }

  process.stdout.write(`Packaged MCP ${server.version} initialized with ${tools.tools.length} tools.\n`);
} finally {
  await client?.close();
  await rm(destination, { recursive: true, force: true });
}
