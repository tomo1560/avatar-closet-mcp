import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { asBoothError } from "./errors.js";
import { BoothService, MAX_LOGIN_TIMEOUT_SEC, MIN_LOGIN_TIMEOUT_SEC } from "./service.js";
import { PACKAGE_VERSION } from "./version.js";

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const LOGIN_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** Logout only deletes local files (session.json and the login browser profile). */
export const LOGOUT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

type ToolAnnotations = typeof READ_ONLY_ANNOTATIONS | typeof LOGIN_ANNOTATIONS | typeof LOGOUT_ANNOTATIONS;

export const SERVER_INSTRUCTIONS =
  "非公式 / Unofficial tool, not affiliated with pixiv or BOOTH. " +
  "Read-only access to the user's own BOOTH buyer account (purchases). BOOTH data is never modified. " +
  "If a tool returns AUTH_REQUIRED, tell the user a browser window will open for a manual pixiv sign-in, call booth_login, then retry.";

const resultOutputShape = {
  data: z.unknown(),
  meta: z.object({
    fetchedAt: z.string(),
    sourceUrl: z.string(),
    page: z.number().optional(),
    nextPage: z.number().optional(),
    redactions: z.array(z.string()),
  }),
};

export function createServer(service = new BoothService()): { server: McpServer; service: BoothService } {
  const server = new McpServer({ name: "booth-library-mcp", version: PACKAGE_VERSION }, { instructions: SERVER_INSTRUCTIONS });

  register(
    server,
    "booth_login",
    "Sign in to BOOTH (unofficial tool, not affiliated with pixiv or BOOTH). Opens Chrome or Edge at accounts.booth.pm so the user can sign in with pixiv manually; credentials are never read or automated. Use when the user asks to connect BOOTH or after a tool returns AUTH_REQUIRED. Waits up to timeout_sec seconds (default 600).",
    {
      timeout_sec: z
        .number()
        .int()
        .min(MIN_LOGIN_TIMEOUT_SEC)
        .max(MAX_LOGIN_TIMEOUT_SEC)
        .optional()
        .describe("How long to wait for the user to finish signing in, in seconds. Defaults to 600."),
    },
    ({ timeout_sec }) => service.login({ timeoutSec: timeout_sec }),
    LOGIN_ANNOTATIONS,
  );
  register(
    server,
    "booth_auth_status",
    "Check whether the saved BOOTH buyer session is signed in, and show the account display name when available. Use when the user asks about the BOOTH connection.",
    {},
    () => service.authStatus(),
  );
  register(
    server,
    "booth_logout",
    "Sign out locally: delete the saved BOOTH session and the dedicated login browser profile (which also holds pixiv cookies). Does not contact BOOTH. Use only when the user asks to disconnect or sign out.",
    {},
    () => service.logout(),
    LOGOUT_ANNOTATIONS,
  );

  return { server, service };
}

export async function startStdioServer(): Promise<void> {
  const { server, service } = createServer();
  const transport = new StdioServerTransport();
  const shutdown = async (): Promise<void> => {
    await service.close();
    await server.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  await server.connect(transport);
}

function register<T extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: T,
  handler: (input: z.infer<z.ZodObject<T>>) => Promise<unknown>,
  annotations: ToolAnnotations = READ_ONLY_ANNOTATIONS,
): void {
  const inputObject = z.object(inputSchema);
  const outputObject = z.object(resultOutputShape);
  server.registerTool<typeof outputObject, typeof inputObject>(
    name,
    { description, inputSchema: inputObject, outputSchema: outputObject, annotations },
    async (input): Promise<CallToolResult> => {
      try {
        const result = await handler(input as z.infer<z.ZodObject<T>>);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

function errorResult(error: unknown): CallToolResult {
  const boothError = asBoothError(error);
  const payload = {
    error: {
      code: boothError.code,
      message: boothError.message,
      ...(boothError.sourceUrl ? { sourceUrl: boothError.sourceUrl } : {}),
    },
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], isError: true };
}
