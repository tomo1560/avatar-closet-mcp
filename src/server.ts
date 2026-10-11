import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runInteractiveLogin } from "./browser/client.js";
import { asBoothError } from "./errors.js";
import { BoothService } from "./service.js";
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

export function createServer(
  service = new BoothService(),
  login: () => Promise<void> = runInteractiveLogin,
): { server: McpServer; service: BoothService } {
  const server = new McpServer(
    { name: "booth-library-mcp", version: PACKAGE_VERSION },
    {
      instructions:
        "Read-only access to the user's BOOTH seller account. Use these tools for questions about their BOOTH shop, products, orders, sales, or customer conversations. The tools do not modify BOOTH data or download files. If a tool returns AUTH_REQUIRED, tell the user that they must sign in before calling booth_login.",
    },
  );

  register(
    server,
    "booth_login",
    "Sign in to BOOTH for subsequent seller-account queries. Use when the user asks to connect BOOTH or after another BOOTH tool returns AUTH_REQUIRED. Opens Chrome or Edge and waits up to 10 minutes for the user to finish signing in.",
    {},
    async () => {
      await login();
      await service.close();
      return {
        data: { authenticated: true },
        meta: {
          fetchedAt: new Date().toISOString(),
          sourceUrl: "https://manage.booth.pm/",
          redactions: [],
        },
      };
    },
    LOGIN_ANNOTATIONS,
  );
  register(
    server,
    "booth_auth_status",
    "Check whether BOOTH is connected and identify the signed-in seller's shop. Use when the user asks about BOOTH connection or account status.",
    {},
    () => service.authStatus(),
  );
  register(
    server,
    "booth_get_dashboard",
    "Get an overview of the BOOTH shop's status and recent sales. Use for a general shop summary or recent performance.",
    {},
    () => service.dashboard(),
  );
  register(
    server,
    "booth_list_items",
    "List products in the BOOTH shop, optionally by publication status. Use for product listings, drafts, or public and private products.",
    {
      state: z.enum(["all", "draft", "public", "private"]).optional().describe("Publication status to include. Defaults to all."),
      page: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    (input) => service.listItems(input),
  );
  register(
    server,
    "booth_get_item",
    "Get one BOOTH product's details, including its description, price, tags, and digital-file metadata. Use when the user refers to a specific product or item ID. Does not download files.",
    { itemId: z.string().regex(/^\d+$/u).describe("Numeric BOOTH item ID.") },
    ({ itemId }) => service.getItem(itemId),
  );
  register(
    server,
    "booth_list_orders",
    "List BOOTH orders, optionally by order status or fulfillment method. Use for order queues, unpaid orders, completed orders, cancellations, or fulfillment lists.",
    {
      state: z
        .enum(["all", "unpaid", "paid", "completed", "cancelled"])
        .optional()
        .describe("Order status to include. Defaults to all."),
      shipment: z
        .enum(["all", "direct", "via_warehouse", "factory_item"])
        .optional()
        .describe("Fulfillment method to include. Defaults to all."),
      page: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    (input) => service.listOrders(input),
  );
  register(
    server,
    "booth_get_order",
    "Get one BOOTH order's details. Use when the user refers to a specific order ID. Personal contact and address fields are masked.",
    { orderId: z.string().regex(/^\d+$/u).describe("Numeric BOOTH order ID.") },
    ({ orderId }) => service.getOrder(orderId),
  );
  register(
    server,
    "booth_get_sales",
    "Get BOOTH sales broken down by month, day, or product. Use for revenue, sales trends, or product performance. Does not export CSV or request payouts.",
    {
      granularity: z.enum(["monthly", "daily", "item"]).optional().describe("How to group sales. Defaults to monthly."),
      page: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    (input) => service.getSales(input),
  );
  register(
    server,
    "booth_list_conversations",
    "List customer conversations in the BOOTH seller inbox. Use when the user asks about messages, inquiries, or conversation threads.",
    {
      page: z.number().int().positive().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    (input) => service.listConversations(input),
  );
  register(
    server,
    "booth_get_conversation",
    "Get one BOOTH customer conversation. Use when the user refers to a specific conversation or asks to read its messages. Message content is omitted unless includeContent is true, and contact details are masked.",
    {
      conversationId: z.string().min(4).max(128).regex(/^[\w-]+$/u).describe("BOOTH conversation ID."),
      includeContent: z.boolean().optional().describe("Whether to include masked message text. Defaults to false."),
    },
    ({ conversationId, includeContent }) => service.getConversation(conversationId, includeContent),
  );
  register(
    server,
    "booth_get_shop_settings",
    "Get the BOOTH shop's public profile and non-financial settings. Use for the shop name, URL, description, publication state, or order preferences.",
    {},
    () => service.getShopSettings(),
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
  annotations: typeof READ_ONLY_ANNOTATIONS | typeof LOGIN_ANNOTATIONS = READ_ONLY_ANNOTATIONS,
): void {
  const inputObject = z.object(inputSchema);
  const outputObject = z.object(resultOutputShape);
  server.registerTool<typeof outputObject, typeof inputObject>(
    name,
    {
      description,
      inputSchema: inputObject,
      outputSchema: outputObject,
      annotations,
    },
    async (input): Promise<CallToolResult> => {
      try {
        const result = await handler(input as z.infer<z.ZodObject<T>>);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (error) {
        const boothError = asBoothError(error);
        const payload = {
          error: {
            code: boothError.code,
            message: boothError.message,
            ...(boothError.sourceUrl ? { sourceUrl: boothError.sourceUrl } : {}),
          },
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          isError: true,
        };
      }
    },
  );
}
