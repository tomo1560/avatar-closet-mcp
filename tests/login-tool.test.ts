import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoothReader } from "../src/browser/reader.js";
import { BoothError } from "../src/errors.js";
import { createServer, SERVER_INSTRUCTIONS } from "../src/server.js";
import { BoothService, type BoothServiceOptions } from "../src/service.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

const loggedOutReader: BoothReader = {
  read: () => Promise.reject(new BoothError("AUTH_REQUIRED", "login required")),
  readJson: () => Promise.reject(new BoothError("AUTH_REQUIRED", "login required")),
  close: () => Promise.resolve(),
};

describe("MCP auth tools", () => {
  it("booth_login waits for login with the requested timeout and returns a structured result", async () => {
    const login = vi.fn(() => Promise.resolve());
    await withClient({ login }, async (client) => {
      const result = await client.callTool({ name: "booth_login", arguments: { timeout_sec: 120 } });
      expect(login).toHaveBeenCalledWith(120_000);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        data: { authenticated: true },
        meta: { sourceUrl: "https://accounts.booth.pm/settings", redactions: [] },
      });
    });
  });

  it("booth_auth_status reports logged out instead of failing", async () => {
    await withClient({}, async (client) => {
      const result = await client.callTool({ name: "booth_auth_status", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ data: { authenticated: false } });
    });
  });

  it("booth_logout deletes local credentials", async () => {
    const appDir = await mkdtemp(join(tmpdir(), "booth-library-mcp-tool-"));
    tempPaths.push(appDir);
    await writeFile(join(appDir, "session.json"), "{}", "utf8");
    await withClient({ env: { BOOTH_MCP_HOME: appDir } }, async (client) => {
      const result = await client.callTool({ name: "booth_logout", arguments: {} });
      expect(result.structuredContent).toMatchObject({ data: { sessionFileRemoved: true, warnings: [] } });
    });
  });

  it("returns tool errors as structured payloads", async () => {
    const login = vi.fn(() => Promise.reject(new BoothError("AUTH_REQUIRED", "ブラウザが閉じられました。")));
    await withClient({ login }, async (client) => {
      const result = await client.callTool({ name: "booth_login", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("AUTH_REQUIRED");
    });
  });

  it("states that the server is unofficial and unaffiliated", () => {
    expect(SERVER_INSTRUCTIONS).toContain("非公式");
    expect(SERVER_INSTRUCTIONS).toMatch(/unofficial/iu);
    expect(SERVER_INSTRUCTIONS).toMatch(/not affiliated with pixiv or BOOTH/iu);
  });
});

async function withClient(options: BoothServiceOptions, run: (client: Client) => Promise<void>): Promise<void> {
  const { server, service } = createServer(new BoothService(loggedOutReader, options));
  const client = new Client({ name: "booth-auth-tools-test", version: "1.0.0" });
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
