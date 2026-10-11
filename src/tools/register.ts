import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { asBoothError } from "../errors.js";

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

/** Opt-in download: GET-only towards BOOTH, but writes a new local file (never overwrites one). */
export const DOWNLOAD_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export type ToolAnnotations =
  | typeof READ_ONLY_ANNOTATIONS
  | typeof LOGIN_ANNOTATIONS
  | typeof LOGOUT_ANNOTATIONS
  | typeof DOWNLOAD_ANNOTATIONS;

/** Appended to every data tool description (PLAN §2.4 design consequences 2 and 5). */
export const UNOFFICIAL_NOTE =
  "非公式ツールで、pixiv / BOOTH とは無関係です。BOOTH へのリクエストは直列・1 秒 1 回以下に制限されています。";

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

/** Registers one tool. Results are compact JSON; every failure becomes `{ error: { code, message } }`. */
export function register<T extends z.ZodRawShape>(
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
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

export function errorResult(error: unknown): CallToolResult {
  const boothError = asBoothError(error);
  const payload = {
    error: {
      code: boothError.code,
      message: boothError.message,
      ...(boothError.sourceUrl ? { sourceUrl: boothError.sourceUrl } : {}),
    },
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], isError: true };
}
