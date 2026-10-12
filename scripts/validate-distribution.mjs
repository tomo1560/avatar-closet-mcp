import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (path) => JSON.parse(await readFile(resolve(root, path), "utf8"));

const packageJson = await readJson("package.json");
const plugin = await readJson(".codex-plugin/plugin.json");
const mcp = await readJson(".mcp.json");
const marketplace = await readJson(".agents/plugins/marketplace.json");
const skill = await readFile(resolve(root, "skills/booth/SKILL.md"), "utf8");
const agentMetadata = await readFile(resolve(root, "skills/booth/agents/openai.yaml"), "utf8");

assert(packageJson.name === "avatar-closet-mcp", "package name must be avatar-closet-mcp");
assert(packageJson.bin?.["avatar-closet-mcp"] === "dist/cli.js", "package must expose the avatar-closet-mcp bin");
assert(plugin.name === "avatar-closet-mcp", "plugin name must be avatar-closet-mcp");
assert(plugin.version === packageJson.version, "plugin version must match package.json");
assertEnglish(packageJson.description, "package description");
assertEnglish(plugin.description, "plugin description");
assertEnglish(plugin.interface.shortDescription, "plugin short description");
assertEnglish(plugin.interface.longDescription, "plugin long description");
for (const [index, prompt] of plugin.interface.defaultPrompt.entries()) {
  assertEnglish(prompt, `plugin default prompt ${index + 1}`);
}
assert(plugin.skills === "./skills/", "plugin must expose ./skills/");
assert(plugin.mcpServers === "./.mcp.json", "plugin must expose ./.mcp.json");
assert(mcp?.mcpServers?.booth?.command === "npx", "booth MCP must use npx");
assert(
  JSON.stringify(mcp.mcpServers.booth.args) === JSON.stringify(["-y", `avatar-closet-mcp@${packageJson.version}`]),
  "booth MCP must pin the package version",
);
assert(marketplace.name === "avatar-closet-mcp", "marketplace name must be avatar-closet-mcp");
const marketplacePlugin = marketplace.plugins?.find((entry) => entry.name === "avatar-closet-mcp");
assert(marketplacePlugin?.source?.source === "npm", "marketplace must use an npm source");
assert(marketplacePlugin?.source?.package === "avatar-closet-mcp", "marketplace must install avatar-closet-mcp");
assert(marketplacePlugin?.source?.version === "latest", "marketplace must follow the latest dist-tag");
assert(/^---\r?\nname: booth\r?\n/u.test(skill), "skill frontmatter name must be booth");
const toolNames = [
  "booth_login",
  "booth_auth_status",
  "booth_logout",
  "booth_get_item",
  "booth_search_items",
  "booth_suggest_tags",
  "booth_check_compatibility",
  "booth_search_for_avatar",
  "booth_list_library",
  "booth_list_gifts",
  "booth_list_free_downloads",
  "booth_list_orders",
  "booth_get_order",
  "booth_list_my_avatars",
  "booth_sync_library_metadata",
  "booth_check_updates",
  "booth_list_wishlist",
  "booth_list_wishlist_names",
  "booth_download",
];
for (const tool of toolNames) {
  assert(skill.includes(`\`${tool}\``), `skill must route the ${tool} tool`);
}
assert(!skill.includes("booth_get_sales"), "skill must not reference removed seller tools");
assert(/evidence/u.test(skill) && /unknown/u.test(skill), "skill must require evidence for VRChat compatibility claims");
assert(/not affiliated with pixiv or BOOTH/u.test(skill), "skill must state that it is unofficial and unaffiliated");
assert(/opt-in/u.test(skill) && /never overwrites/u.test(skill), "skill must describe booth_download as opt-in and non-overwriting");
assert(/first_run/u.test(skill) && /baseline/u.test(skill), "skill must explain that the first booth_check_updates call only records a baseline");
assert(skill.includes("avatar-closet-mcp unity-check"), "skill must route Unity project questions to the unity-check CLI command");
assert(agentMetadata.includes("allow_implicit_invocation: true"), "skill must allow implicit invocation");
assert(agentMetadata.includes('value: "booth"'), "skill must depend on the booth MCP server");
assertEnglish(skill, "skill instructions");
assertEnglish(agentMetadata, "skill agent metadata");

const includedFiles = new Set(packageJson.files);
for (const required of ["dist", ".codex-plugin", ".mcp.json", "skills", "README.md", "LICENSE"]) {
  assert(includedFiles.has(required), `package.json files must include ${required}`);
}

process.stdout.write(`Distribution metadata is valid for ${packageJson.version}.\n`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEnglish(value, label) {
  assert(typeof value === "string" && /^[\x00-\x7F]*$/u.test(value), `${label} must contain English ASCII text only`);
}
