import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { BoothError } from "../src/errors.js";
import { createPlaywrightTransport, type BoothTransport } from "../src/browser/transport.js";

const servers: Server[] = [];
const transports: BoothTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map(async (transport) => transport.close()));
  await Promise.all(servers.splice(0).map(async (server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Playwright request transport (local server only)", () => {
  it("does not follow redirects and exposes the Location header", async () => {
    const seen: string[] = [];
    const origin = await startServer((request, response) => {
      seen.push(request.url ?? "");
      response.writeHead(302, { location: "/elsewhere" }).end();
    });
    const transport = await track(createPlaywrightTransport({ cookies: [], origins: [] }));
    const response = await transport.get(`${origin}/start`, { Accept: "text/html" });
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/elsewhere");
    expect(seen).toEqual(["/start"]);
    await response.dispose();
  });

  it("sends cookies from the storage state and captures Set-Cookie for write-back", async () => {
    let receivedCookie: string | undefined;
    const origin = await startServer((request, response) => {
      receivedCookie = request.headers.cookie;
      response.writeHead(200, { "content-type": "text/plain", "set-cookie": "refreshed=new-value; Path=/" }).end("ok");
    });
    const transport = await track(
      createPlaywrightTransport({
        cookies: [{ name: "seed", value: "fictional", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }],
        origins: [],
      }),
    );
    const response = await transport.get(`${origin}/`, {});
    expect(await response.text()).toBe("ok");
    expect(receivedCookie).toBe("seed=fictional");
    const state = await transport.storageState();
    expect(state.cookies.map((cookie) => cookie.name).sort()).toEqual(["refreshed", "seed"]);
  });

  it("strips the multi-line call log (which may contain cookies) from network errors", async () => {
    const transport = await track(
      createPlaywrightTransport({
        cookies: [{ name: "secret", value: "do-not-leak", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }],
        origins: [],
      }),
    );
    const failure = await transport.get("http://127.0.0.1:1/unreachable", {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BoothError);
    expect((failure as BoothError).code).toBe("NETWORK_ERROR");
    expect((failure as BoothError).message).not.toContain("\n");
    expect((failure as BoothError).message).not.toContain("do-not-leak");
  });
});

async function track(promise: Promise<BoothTransport>): Promise<BoothTransport> {
  const transport = await promise;
  transports.push(transport);
  return transport;
}

async function startServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not start");
  return `http://127.0.0.1:${address.port}`;
}
