import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BoothService } from "./service.js";
import { registerAuthTools } from "./tools/auth-tools.js";
import { downloadStartupWarning, registerDownloadTools } from "./tools/download-tools.js";
import { registerItemTools } from "./tools/item-tools.js";
import { registerLibraryTools } from "./tools/library-tools.js";
import { PACKAGE_VERSION } from "./version.js";

export { DOWNLOAD_ANNOTATIONS, LOGIN_ANNOTATIONS, LOGOUT_ANNOTATIONS, READ_ONLY_ANNOTATIONS } from "./tools/register.js";

export const SERVER_INSTRUCTIONS =
  "非公式 / Unofficial tool, not affiliated with pixiv or BOOTH. " +
  "Read-only access to the user's own BOOTH buyer account (library, gifts, orders) and to public item data. BOOTH data is never modified. " +
  "Requests are serial and rate-limited (at most 1 per second), so prefer cached data and avoid unnecessary calls. " +
  "VRChat compatibility results are evidence-based heuristics: quote the evidence and never claim support without it (unknown means no evidence). " +
  "If a tool returns AUTH_REQUIRED, tell the user a browser window will open for a manual pixiv sign-in, call booth_login, then retry.";

export function createServer(service = new BoothService()): { server: McpServer; service: BoothService } {
  const server = new McpServer({ name: "booth-library-mcp", version: PACKAGE_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerAuthTools(server, service);
  registerItemTools(server, service);
  registerLibraryTools(server, service);
  // Opt-in (PLAN §2.4): the download tool does not exist unless the user enabled and configured it.
  if (service.downloadConfig().enabled) registerDownloadTools(server, service);
  return { server, service };
}

export async function startStdioServer(): Promise<void> {
  const { server, service } = createServer();
  const warning = downloadStartupWarning(process.env, service.downloadConfig());
  if (warning) process.stderr.write(warning);
  const transport = new StdioServerTransport();
  const shutdown = async (): Promise<void> => {
    await service.close();
    await server.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  await server.connect(transport);
}
