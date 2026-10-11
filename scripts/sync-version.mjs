import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const targets = [
  resolve(root, ".codex-plugin", "plugin.json"),
  resolve(root, ".mcp.json"),
];

const packageJson = await readJson(resolve(root, "package.json"));
if (typeof packageJson.version !== "string" || !semverPattern.test(packageJson.version)) {
  throw new Error("package.json version must be strict semver");
}

const originals = await Promise.all(targets.map((path) => readFile(path, "utf8")));
const plugin = JSON.parse(originals[0]);
const mcp = JSON.parse(originals[1]);

plugin.version = packageJson.version;
const boothArgs = mcp?.mcpServers?.booth?.args;
if (!Array.isArray(boothArgs) || boothArgs.length !== 2 || boothArgs[0] !== "-y") {
  throw new Error(".mcp.json must define booth args as [-y, booth-library-mcp@<version>]");
}
boothArgs[1] = `booth-library-mcp@${packageJson.version}`;

const expected = [serialize(plugin), serialize(mcp)];
const drifted = targets.filter((_, index) => originals[index] !== expected[index]);

if (checkOnly) {
  if (drifted.length > 0) {
    throw new Error(`version metadata is out of sync: ${drifted.map(relative).join(", ")}`);
  }
  process.stdout.write(`Version metadata matches ${packageJson.version}.\n`);
  process.exit(0);
}

if (drifted.length === 0) {
  process.stdout.write(`Version metadata already matches ${packageJson.version}.\n`);
  process.exit(0);
}

const temporaryPaths = targets.map((path) => `${path}.${process.pid}.tmp`);
try {
  await Promise.all(temporaryPaths.map((path, index) => writeFile(path, expected[index], "utf8")));
  for (let index = 0; index < targets.length; index += 1) {
    await rename(temporaryPaths[index], targets[index]);
  }
} catch (error) {
  await Promise.allSettled(temporaryPaths.map((path) => unlink(path)));
  await Promise.allSettled(targets.map((path, index) => writeFile(path, originals[index], "utf8")));
  throw error;
}

process.stdout.write(`Synchronized version metadata to ${packageJson.version}.\n`);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function relative(path) {
  return path.slice(root.length + 1).replaceAll("\\", "/");
}
