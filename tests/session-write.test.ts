import type * as FsPromises from "node:fs/promises";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoothHttpClient } from "../src/browser/http-client.js";
import { persistBoothSession, type StorageCookie } from "../src/session-state.js";
import { createFakeClock, FakeTransportHarness } from "./helpers/fake-transport.js";

/** Which fs call fails next (only for the temporary file of an atomic write). */
const failures = vi.hoisted(() => ({ open: undefined as string | undefined, rename: undefined as string | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const errno = (code: string, path: string): Error =>
    Object.assign(new Error(`${code}: simulated failure, open '${path}'`), { code, syscall: "open", path });
  return {
    ...actual,
    open: ((path: string, ...rest: unknown[]) => {
      if (failures.open && String(path).endsWith(".tmp")) return Promise.reject(errno(failures.open, String(path)));
      return (actual.open as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof actual.open,
    rename: ((from: string, to: string) => {
      if (failures.rename) return Promise.reject(errno(failures.rename, String(to)));
      return actual.rename(from, to);
    }) as typeof actual.rename,
  };
});

const tempPaths: string[] = [];
const clients: BoothHttpClient[] = [];

afterEach(async () => {
  failures.open = undefined;
  failures.rename = undefined;
  await Promise.all(clients.splice(0).map(async (client) => client.close()));
  await Promise.all(tempPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("atomic session writes", () => {
  it("keeps the previous session.json intact and leaves no temporary file when publishing fails", async () => {
    const directory = await createTempDirectory();
    const sessionFile = join(directory, "session.json");
    await writeFile(sessionFile, "ORIGINAL", "utf8");
    failures.rename = "EIO";

    await expect(persistBoothSession(jar([cookie("_plaza_session_test", "new")]), sessionFile)).rejects.toMatchObject({ code: "EIO" });

    expect(await readFile(sessionFile, "utf8")).toBe("ORIGINAL");
    expect(await readdir(directory)).toEqual(["session.json"]);
  });

  it("does not touch session.json when the temporary file cannot be created", async () => {
    const directory = await createTempDirectory();
    const sessionFile = join(directory, "session.json");
    await writeFile(sessionFile, "ORIGINAL", "utf8");
    failures.open = "EACCES";

    await expect(persistBoothSession(jar([]), sessionFile)).rejects.toMatchObject({ code: "EACCES" });

    expect(await readFile(sessionFile, "utf8")).toBe("ORIGINAL");
    expect(await readdir(directory)).toEqual(["session.json"]);
  });

  it("replaces session.json in one step and leaves no temporary file on success", async () => {
    const directory = await createTempDirectory();
    const sessionFile = join(directory, "session.json");
    await writeFile(sessionFile, "ORIGINAL", "utf8");

    await persistBoothSession(jar([cookie("_plaza_session_test", "new")]), sessionFile);

    expect(JSON.parse(await readFile(sessionFile, "utf8"))).toMatchObject({ cookies: [{ value: "new" }, { name: "adult" }] });
    expect(await readdir(directory)).toEqual(["session.json"]);
  });
});

describe("cookie write-back failures", () => {
  it("still returns the response when session.json cannot be written (EACCES), and warns without the path", async () => {
    const directory = await createTempDirectory();
    const sessionFile = join(directory, "session.json");
    const original = JSON.stringify({ cookies: [cookie("_plaza_session_test", "fictional-0")], origins: [] });
    await writeFile(sessionFile, original, "utf8");
    const warnings: string[] = [];
    const client = createClient(sessionFile, warnings);
    failures.open = "EACCES";

    await expect(client.read("https://accounts.booth.pm/library", (html) => html)).resolves.toMatchObject({ data: "<main></main>" });
    await expect(client.read("https://accounts.booth.pm/library", (html) => html)).resolves.toMatchObject({ data: "<main></main>" });

    expect(await readFile(sessionFile, "utf8")).toBe(original);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("EACCES");
    expect(warnings[0]).not.toContain(directory);
    expect(warnings[0]).not.toContain("fictional-0");
  });

  it("warns again after a successful write-back if writing fails later", async () => {
    const directory = await createTempDirectory();
    const sessionFile = join(directory, "session.json");
    await writeFile(sessionFile, JSON.stringify({ cookies: [cookie("_plaza_session_test", "fictional-0")], origins: [] }), "utf8");
    const warnings: string[] = [];
    const client = createClient(sessionFile, warnings);

    failures.open = "ENOSPC";
    await client.read("/ja", (html) => html);
    failures.open = undefined;
    await client.read("/ja", (html) => html);
    failures.open = "ENOSPC";
    await client.read("/ja", (html) => html);

    expect(warnings).toHaveLength(2);
  });
});

function createClient(sessionFile: string, warnings: string[]): BoothHttpClient {
  const harness = new FakeTransportHarness(() => ({ status: 200, body: "<main></main>" }));
  const clock = createFakeClock();
  const client = new BoothHttpClient({
    sessionFile,
    transportFactory: harness.factory,
    sleep: clock.sleep,
    now: clock.now,
    onWarning: (message) => void warnings.push(message),
  });
  clients.push(client);
  return client;
}

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "booth-library-mcp-session-write-"));
  tempPaths.push(directory);
  return directory;
}

function jar(cookies: StorageCookie[]): { storageState: () => Promise<{ cookies: StorageCookie[]; origins: [] }> } {
  return { storageState: () => Promise.resolve({ cookies, origins: [] }) };
}

function cookie(name: string, value: string): StorageCookie {
  return { name, value, domain: ".booth.pm", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" };
}
