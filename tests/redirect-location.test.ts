import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoothHttpClient } from "../src/browser/http-client.js";
import type { BoothError } from "../src/errors.js";
import { createFakeClock, FakeTransportHarness, type FakeHandler } from "./helpers/fake-transport.js";

const tempPaths: string[] = [];
const SIGNED = "https://downloads.example.net/files/Outfit_Fictional_v1.zip?Signature=fictional-secret";

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("getRedirectLocation (Phase 3 download primitive)", () => {
  it("returns the Location of a downloadable without following it", async () => {
    const { client, harness } = await setup(() => ({ status: 302, headers: { location: SIGNED } }));
    await expect(client.getRedirectLocation("https://booth.pm/downloadables/42")).resolves.toEqual({
      status: 302,
      location: SIGNED,
    });
    expect(harness.requests.map((request) => request.url)).toEqual(["https://booth.pm/downloadables/42"]);
  });

  it("accepts a variation_id query and relative paths", async () => {
    const { client, harness } = await setup(() => ({ status: 302, headers: { location: SIGNED } }));
    await client.getRedirectLocation("/downloadables/42?variation_id=7");
    expect(harness.requests[0]?.url).toBe("https://booth.pm/downloadables/42?variation_id=7");
  });

  it.each([
    "https://booth.pm/ja/items/42.json",
    "https://accounts.booth.pm/downloadables/42",
    "https://example.com/downloadables/42",
    "https://booth.pm/downloadables/42?redirect=https://example.com",
  ])("rejects %s without sending a request", async (url) => {
    const { client, harness } = await setup(() => ({ status: 302, headers: { location: SIGNED } }));
    await expect(client.getRedirectLocation(url)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(harness.requests).toEqual([]);
  });

  it("requires a saved session", async () => {
    const { client, harness } = await setup(() => ({ status: 302, headers: { location: SIGNED } }), false);
    await expect(client.getRedirectLocation("https://booth.pm/downloadables/42")).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    expect(harness.requests).toEqual([]);
  });

  it("reports AUTH_REQUIRED for a sign-in redirect without echoing the Location", async () => {
    const location = "https://booth.pm/users/sign_in?return_to=fictional-secret";
    const { client } = await setup(() => ({ status: 302, headers: { location } }));
    const error = (await client.getRedirectLocation("/downloadables/42").catch((e: unknown) => e)) as BoothError;
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(`${error.message} ${error.sourceUrl ?? ""}`).not.toContain("fictional-secret");
  });

  it("returns no location for a non-redirect response and maps 404", async () => {
    const { client } = await setup((_request, index) => (index === 0 ? { status: 200 } : { status: 404 }));
    await expect(client.getRedirectLocation("/downloadables/1")).resolves.toEqual({ status: 200, location: undefined });
    await expect(client.getRedirectLocation("/downloadables/2")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("uses the same backoff for 429", async () => {
    const { client, harness } = await setup((_request, index) =>
      index === 0 ? { status: 429 } : { status: 302, headers: { location: SIGNED } },
    );
    await expect(client.getRedirectLocation("/downloadables/42")).resolves.toMatchObject({ status: 302 });
    expect(harness.requests).toHaveLength(2);
  });
});

async function setup(handler: FakeHandler, withSession = true): Promise<{ client: BoothHttpClient; harness: FakeTransportHarness }> {
  const directory = await mkdtemp(join(tmpdir(), "avatar-closet-mcp-redirect-"));
  tempPaths.push(directory);
  const sessionFile = join(directory, "session.json");
  if (withSession) await writeFile(sessionFile, JSON.stringify({ cookies: [], origins: [] }), "utf8");
  const harness = new FakeTransportHarness(handler);
  const clock = createFakeClock();
  const client = new BoothHttpClient({ sessionFile, transportFactory: harness.factory, sleep: clock.sleep, now: clock.now });
  return { client, harness };
}
