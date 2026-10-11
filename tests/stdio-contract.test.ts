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

  it("publishes the buyer auth tools with schemas and annotations", async () => {
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
    expect(response.tools.map((tool) => tool.name)).toEqual(["booth_login", "booth_auth_status", "booth_logout"]);
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
    const login = response.tools.find((tool) => tool.name === "booth_login");
    expect(Object.keys(login?.inputSchema.properties ?? {})).toEqual(["timeout_sec"]);
  });
});
