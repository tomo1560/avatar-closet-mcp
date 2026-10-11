import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoothHttpClient, MAX_RESPONSE_BYTES } from "../src/browser/http-client.js";
import type { BoothError } from "../src/errors.js";
import type { StorageCookie, StorageState } from "../src/session-state.js";
import { createFakeClock, FakeTransportHarness, type FakeHandler } from "./helpers/fake-transport.js";

const tempPaths: string[] = [];
const clients: BoothHttpClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => client.close()));
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

const ok = (body = "<main></main>"): ReturnType<FakeHandler> => ({ status: 200, body });

describe("anonymous (no session) access", () => {
  it("serves public booth.pm GETs without session cookies and never creates session.json", async () => {
    const { client, harness, sessionFile } = await setup(() => ok('{"id":123}'), { withSession: false });
    const result = await client.readJson("https://booth.pm/ja/items/123.json", (json) => json);
    expect(result).toEqual({ data: { id: 123 }, url: "https://booth.pm/ja/items/123.json" });
    expect(harness.createdWith).toHaveLength(1);
    expect(harness.createdWith[0]?.cookies.map((cookie) => cookie.name)).toEqual(["adult"]);
    await expect(readFile(sessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects accounts.booth.pm without a session before sending anything", async () => {
    const { client, harness } = await setup(() => ok(), { withSession: false });
    await expect(client.read("https://accounts.booth.pm/library?page=2", (html) => html)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    expect(harness.requests).toEqual([]);
  });

  it("picks up a session saved after the client started (e.g. login from another process)", async () => {
    const { client, harness, sessionFile } = await setup(() => ok(), { withSession: false });
    await client.read("https://booth.pm/ja/search/test?page=1", (html) => html);
    await writeSession(sessionFile, [boothCookie("_plaza_session_test", "fictional-1")]);
    await client.read("https://accounts.booth.pm/library", (html) => html);
    expect(harness.createdWith).toHaveLength(2);
    expect(harness.createdWith[1]?.cookies.map((cookie) => cookie.name)).toEqual(["_plaza_session_test", "adult"]);
  });
});

describe("host allowlist", () => {
  it.each(["https://example.com/", "https://sample-shop.booth.pm/items/1", "http://booth.pm/", "//example.com/x"])(
    "rejects %s without sending a request",
    async (url) => {
      const { client, harness } = await setup(() => ok());
      await expect(client.read(url, (html) => html)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(harness.requests).toEqual([]);
      expect(harness.createdWith).toEqual([]);
    },
  );

  it("rejects a disallowed readJson origin option", async () => {
    const { client, harness } = await setup(() => ok());
    await expect(client.readJson("/x.json", (json) => json, { origin: "https://api.booth.pm" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(harness.requests).toEqual([]);
  });

  it("resolves relative paths against booth.pm and an allowed origin option", async () => {
    const { client, harness } = await setup(() => ok("{}"));
    await client.read("/ja/items/1", (html) => html);
    await client.readJson("/library.json", (json) => json, { origin: "https://accounts.booth.pm" });
    expect(harness.requests.map((request) => request.url)).toEqual([
      "https://booth.pm/ja/items/1",
      "https://accounts.booth.pm/library.json",
    ]);
  });
});

describe("redirects", () => {
  it("treats a redirect to the sign-in page as AUTH_REQUIRED", async () => {
    const { client } = await setup(() => ({ status: 302, headers: { location: "https://booth.pm/users/sign_in" } }));
    await expect(client.read("https://accounts.booth.pm/settings", (html) => html)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("treats a same-host sign-in redirect as AUTH_REQUIRED", async () => {
    const { client } = await setup(() => ({ status: 302, headers: { location: "/ja/users/sign_in" } }));
    await expect(client.read("https://booth.pm/ja/items/1.json", (html) => html)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("treats a redirect to another host as AUTH_REQUIRED without leaking the Location", async () => {
    const location = "https://files.example.net/signed?token=fictional-secret";
    const { client } = await setup(() => ({ status: 302, headers: { location } }));
    const error = (await client.read("https://booth.pm/ja/items/1", (html) => html).catch((e: unknown) => e)) as BoothError;
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(`${error.message} ${error.sourceUrl ?? ""}`).not.toContain("fictional-secret");
  });

  it("follows same-host redirects and reports the final URL", async () => {
    const { client, harness } = await setup((_request, index) =>
      index === 0 ? { status: 301, headers: { location: "/ja/items/1.json" } } : ok('{"id":1}'),
    );
    const result = await client.readJson("https://booth.pm/items/1.json", (json, url) => ({ json, url }));
    expect(result.url).toBe("https://booth.pm/ja/items/1.json");
    expect(harness.requests).toHaveLength(2);
  });
});

describe("status handling and parsing", () => {
  it.each([
    [404, "NOT_FOUND"],
    [500, "NETWORK_ERROR"],
  ] as const)("maps HTTP %s to %s", async (status, code) => {
    const { client } = await setup(() => ({ status }));
    await expect(client.read("/ja/items/1", (html) => html)).rejects.toMatchObject({ code });
  });

  it("reports BOOTH_CHANGED for a non-JSON body on a JSON endpoint", async () => {
    const { client } = await setup(() => ok("<html>maintenance</html>"));
    await expect(client.readJson("/ja/items/1.json", (json) => json)).rejects.toMatchObject({ code: "BOOTH_CHANGED" });
  });

  it("refuses a response whose declared size exceeds the cap without parsing it", async () => {
    let parsed = false;
    const { client } = await setup(() => ({ status: 200, headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) }, body: "x" }));
    const read = client.read("/ja/items/1", (html) => {
      parsed = true;
      return html;
    });
    await expect(read).rejects.toMatchObject({ code: "BOOTH_CHANGED" });
    expect(parsed).toBe(false);
  });

  it("refuses an oversized body that did not declare its size", async () => {
    const { client } = await setup(() => ok("a".repeat(MAX_RESPONSE_BYTES + 1)));
    await expect(client.read("/ja/items/1", (html) => html.length)).rejects.toMatchObject({ code: "BOOTH_CHANGED" });
  });

  it("accepts a body of exactly the cap", async () => {
    const { client } = await setup(() => ok("a".repeat(MAX_RESPONSE_BYTES)));
    await expect(client.read("/ja/items/1", (html) => html.length)).resolves.toMatchObject({ data: MAX_RESPONSE_BYTES });
  });

  it("extracts a CSRF token from HTML before calling a JSON endpoint", async () => {
    const { client, harness } = await setup((request) =>
      request.url.endsWith("/detail") ? ok("<meta name='csrf-token' content='token-value'><main></main>") : ok('{"ok":true}'),
    );
    const result = await client.readJson("/api.json", (json) => json, { csrfFrom: "/detail" });
    expect(result.data).toEqual({ ok: true });
    expect(harness.requests[1]?.headers["X-CSRF-Token"]).toBe("token-value");
  });

  it("strips multi-line transport errors", async () => {
    const { client } = await setup(() => {
      throw new Error("apiRequestContext.get: connect failed\nCall log:\n  cookie: _plaza_session=fictional-secret");
    });
    const error = (await client.read("/ja", (html) => html).catch((e: unknown) => e)) as BoothError;
    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.message).not.toContain("fictional-secret");
  });
});

describe("cookie write-back", () => {
  it("writes refreshed BOOTH cookies (plus adult=t) back to session.json and drops pixiv cookies", async () => {
    const { client, harness, sessionFile } = await setup(() => ok());
    harness.jar = {
      cookies: [boothCookie("_plaza_session_test", "refreshed"), { ...boothCookie("PHPSESSID", "pixiv"), domain: ".pixiv.net" }],
      origins: [],
    };
    await client.read("https://accounts.booth.pm/library", (html) => html);
    const saved = JSON.parse(await readFile(sessionFile, "utf8")) as StorageState;
    expect(saved.cookies.map((cookie) => [cookie.name, cookie.value])).toEqual([
      ["_plaza_session_test", "refreshed"],
      ["adult", "t"],
    ]);
  });

  it("injects adult=t into the request context of a saved session", async () => {
    const { client, harness } = await setup(() => ok());
    await client.read("/ja/items/1", (html) => html);
    expect(harness.createdWith[0]?.cookies.find((cookie) => cookie.name === "adult")).toMatchObject({
      value: "t",
      domain: ".booth.pm",
      path: "/",
    });
  });

  it("does not resurrect session.json after it was deleted (logout race)", async () => {
    const { client, sessionFile } = await setup(() => ok());
    await client.read("/ja", (html) => html);
    await rm(sessionFile);
    await client.read("/ja", (html) => html);
    await expect(readFile(sessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not clobber a session.json changed by another process, and reloads it for the next request", async () => {
    const { client, harness, sessionFile } = await setup(() => ok());
    await client.read("/ja", (html) => html);
    // Another process (e.g. `login` from the CLI) saves a new session meanwhile. Different length on purpose:
    // the change must be detected even when the file system's mtime granularity hides it.
    await writeSession(sessionFile, [boothCookie("_plaza_session_test", "from-another-process-login")]);
    const external = await readFile(sessionFile, "utf8");
    harness.jar = { cookies: [boothCookie("_plaza_session_test", "stale-in-memory")], origins: [] };

    await client.read("/ja", (html) => html);
    expect(await readFile(sessionFile, "utf8")).toBe(external);

    await client.read("/ja", (html) => html);
    expect(harness.createdWith).toHaveLength(2);
    expect(harness.createdWith[1]?.cookies.find((cookie) => cookie.name === "_plaza_session_test")?.value).toBe(
      "from-another-process-login",
    );
  });

  it("keeps writing back after its own write (its own changes are not mistaken for another process)", async () => {
    const { client, harness, sessionFile } = await setup(() => ok());
    harness.jar = { cookies: [boothCookie("_plaza_session_test", "rotated-1")], origins: [] };
    await client.read("/ja", (html) => html);
    harness.jar = { cookies: [boothCookie("_plaza_session_test", "rotated-2-longer")], origins: [] };
    await client.read("/ja", (html) => html);
    const saved = JSON.parse(await readFile(sessionFile, "utf8")) as StorageState;
    expect(saved.cookies.find((cookie) => cookie.name === "_plaza_session_test")?.value).toBe("rotated-2-longer");
    expect(harness.createdWith).toHaveLength(1);
  });

  it("disposes the transport on close and recreates it for the next request", async () => {
    const { client, harness } = await setup(() => ok());
    await client.read("/ja", (html) => html);
    await client.close();
    await client.read("/ja", (html) => html);
    expect(harness.closedCount).toBe(1);
    expect(harness.createdWith).toHaveLength(2);
  });
});

async function setup(
  handler: FakeHandler,
  options: { withSession?: boolean } = {},
): Promise<{ client: BoothHttpClient; harness: FakeTransportHarness; sessionFile: string }> {
  const directory = await mkdtemp(join(tmpdir(), "booth-library-mcp-http-"));
  tempPaths.push(directory);
  const sessionFile = join(directory, "session.json");
  if (options.withSession !== false) await writeSession(sessionFile, [boothCookie("_plaza_session_test", "fictional-0")]);
  const harness = new FakeTransportHarness(handler);
  const clock = createFakeClock();
  const client = new BoothHttpClient({ sessionFile, transportFactory: harness.factory, sleep: clock.sleep, now: clock.now });
  clients.push(client);
  return { client, harness, sessionFile };
}

async function writeSession(sessionFile: string, cookies: StorageCookie[]): Promise<void> {
  await writeFile(sessionFile, JSON.stringify({ cookies, origins: [] }), "utf8");
}

function boothCookie(name: string, value: string): StorageCookie {
  return { name, value, domain: ".booth.pm", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" };
}
