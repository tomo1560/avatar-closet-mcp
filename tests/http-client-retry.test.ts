import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoothHttpClient, MIN_REQUEST_INTERVAL_MS } from "../src/browser/http-client.js";
import { createFakeClock, FakeTransportHarness, type FakeHandler } from "./helpers/fake-transport.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("rate limiting and backoff", () => {
  it("backs off after a 429 and then succeeds", async () => {
    const { client, harness, clock } = await setup((_request, index) => (index === 0 ? { status: 429 } : { status: 200, body: "ok" }));
    const result = await client.read("/ja/items/1", (html) => html);
    expect(result.data).toBe("ok");
    expect(harness.requests).toHaveLength(2);
    expect(clock.sleeps).toEqual([2_000]);
  });

  it("gives up with RATE_LIMITED after four 429 responses (three retries)", async () => {
    const { client, harness, clock } = await setup(() => ({ status: 429 }));
    await expect(client.read("/ja/items/1", (html) => html)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(harness.requests).toHaveLength(4);
    expect(clock.sleeps).toEqual([2_000, 4_000, 8_000]);
  });

  it("retries 503 the same way", async () => {
    const { client, clock } = await setup((_request, index) => (index < 2 ? { status: 503 } : { status: 200, body: "ok" }));
    await expect(client.read("/ja", (html) => html)).resolves.toMatchObject({ data: "ok" });
    expect(clock.sleeps).toEqual([2_000, 4_000]);
  });

  it("honours Retry-After seconds and caps them at 30 seconds", async () => {
    const { client, clock } = await setup((_request, index) => {
      if (index === 0) return { status: 429, headers: { "retry-after": "5" } };
      if (index === 1) return { status: 429, headers: { "retry-after": "600" } };
      return { status: 200, body: "ok" };
    });
    await client.read("/ja", (html) => html);
    expect(clock.sleeps).toEqual([5_000, 30_000]);
  });

  it("serializes concurrent requests with at least one second between them", async () => {
    const { client, harness, clock } = await setup((request) => ({ status: 200, body: request.url }));
    const results = await Promise.all([
      client.read("/ja/a", (html) => html),
      client.read("/ja/b", (html) => html),
      client.read("/ja/c", (html) => html),
    ]);
    expect(results.map((result) => result.data)).toEqual([
      "https://booth.pm/ja/a",
      "https://booth.pm/ja/b",
      "https://booth.pm/ja/c",
    ]);
    expect(harness.requests.map((request) => request.url)).toEqual(results.map((result) => result.data));
    expect(clock.sleeps).toEqual([MIN_REQUEST_INTERVAL_MS, MIN_REQUEST_INTERVAL_MS]);
    expect(MIN_REQUEST_INTERVAL_MS).toBe(1_000);
  });

  it("keeps the queue running after a failed request", async () => {
    const { client } = await setup((_request, index) => (index === 0 ? { status: 404 } : { status: 200, body: "ok" }));
    const [first, second] = await Promise.allSettled([client.read("/ja/a", (html) => html), client.read("/ja/b", (html) => html)]);
    expect(first.status).toBe("rejected");
    expect(second).toMatchObject({ status: "fulfilled", value: { data: "ok" } });
  });
});

async function setup(handler: FakeHandler): Promise<{
  client: BoothHttpClient;
  harness: FakeTransportHarness;
  clock: ReturnType<typeof createFakeClock>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "avatar-closet-mcp-retry-"));
  tempPaths.push(directory);
  const harness = new FakeTransportHarness(handler);
  const clock = createFakeClock();
  const client = new BoothHttpClient({
    sessionFile: join(directory, "session.json"),
    transportFactory: harness.factory,
    sleep: clock.sleep,
    now: clock.now,
  });
  return { client, harness, clock };
}
