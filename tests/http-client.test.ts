import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoothHttpClient } from "../src/browser/http-client.js";
import { persistBoothSession } from "../src/session-state.js";

const tempPaths: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("browserless HTTP transport", () => {
  it("uses a direct GET request without launching a browser", async () => {
    const requests: string[] = [];
    const { origin, sessionFile } = await createMockServer((request, response) => {
      requests.push(request.method ?? "");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<main><h1>Dashboard</h1></main>");
    });
    const client = new BoothHttpClient({ origin, sessionFile, minimumIntervalMs: 0 });
    try {
      const result = await client.read("/", (html) => html.includes("Dashboard"));
      expect(result.data).toBe(true);
      expect(requests).toEqual(["GET"]);
    } finally {
      await client.close();
    }
  });

  it("extracts a CSRF token from HTML before calling a JSON endpoint", async () => {
    const { origin, sessionFile } = await createMockServer((request, response) => {
      if (request.url === "/detail") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<meta name='csrf-token' content='token-value'><main></main>");
        return;
      }
      if (request.url === "/api" && request.headers["x-csrf-token"] === "token-value") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        return;
      }
      response.writeHead(403).end();
    });
    const client = new BoothHttpClient({ origin, sessionFile, minimumIntervalMs: 0 });
    try {
      const result = await client.readJson("/api", (json) => json, { csrfFrom: "/detail" });
      expect(result.data).toEqual({ ok: true });
    } finally {
      await client.close();
    }
  });

  it("stores only BOOTH cookies and origins in the portable session file", async () => {
    const directory = await createTempDirectory();
    const sessionFile = join(directory, "session.json");
    const context = {
      storageState: () => Promise.resolve({
        cookies: [cookie("booth_session", "manage.booth.pm"), cookie("unrelated", ".example.com")],
        origins: [
          { origin: "https://manage.booth.pm", localStorage: [] },
          { origin: "https://example.com", localStorage: [] },
        ],
      }),
    };
    await persistBoothSession(context, sessionFile);
    const saved = JSON.parse(await readFile(sessionFile, "utf8")) as {
      cookies: Array<{ name: string }>;
      origins: Array<{ origin: string }>;
    };
    expect(saved.cookies.map((entry) => entry.name)).toEqual(["booth_session"]);
    expect(saved.origins.map((entry) => entry.origin)).toEqual(["https://manage.booth.pm"]);
  });
});

async function createMockServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ origin: string; sessionFile: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not start");
  const directory = await createTempDirectory();
  const sessionFile = join(directory, "session.json");
  await writeFile(sessionFile, JSON.stringify({ cookies: [], origins: [] }), "utf8");
  return { origin: `http://127.0.0.1:${address.port}`, sessionFile };
}

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "booth-library-mcp-test-"));
  tempPaths.push(directory);
  return directory;
}

function cookie(name: string, domain: string): {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax";
} {
  return { name, value: "secret", domain, path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" };
}
