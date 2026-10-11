import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

describe("version metadata", () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("matches the package version", () => {
    expect(() => execFileSync(process.execPath, ["scripts/sync-version.mjs", "--check"], { stdio: "pipe" })).not.toThrow();
  });

  it("rejects drift without modifying files", () => {
    const fixture = createFixture();
    const manifestPath = join(fixture, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string };
    manifest.version = "9.9.9";
    const drifted = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(manifestPath, drifted);

    expect(() =>
      execFileSync(process.execPath, [join(fixture, "scripts", "sync-version.mjs"), "--check"], {
        cwd: fixture,
        stdio: "pipe",
      }),
    ).toThrow();
    expect(readFileSync(manifestPath, "utf8")).toBe(drifted);
  });
});

function createFixture(): string {
  const fixture = mkdtempSync(join(tmpdir(), "booth-library-mcp-version-"));
  temporaryDirectories.push(fixture);
  mkdirSync(join(fixture, "scripts"));
  mkdirSync(join(fixture, ".codex-plugin"));
  for (const path of ["package.json", ".mcp.json", ".codex-plugin/plugin.json", "scripts/sync-version.mjs"]) {
    cpSync(path, join(fixture, path));
  }
  return fixture;
}
