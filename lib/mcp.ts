import { prisma } from "./prisma";
import { formatPaise } from "./money";
import { getPolicyConfig, getDailySpentPaise, requestCheckout, checkApprovalStatus } from "./checkout";
import { getOrCreateMandateSetupLink, getMandateRecord, toMandateView } from "./mandate";
import { appendAuditEvent } from "./audit";
import { gatewayMode } from "./razorpay";

/**
 * Shared Model Context Protocol tool surface.
 *
 * The same definitions and dispatcher back all three transports: the
 * JSON-RPC 2.0 HTTP endpoint (/api/mcp), the stdio server for Claude Desktop
 * (scripts/mcp-server.ts) and the OpenAPI REST actions used by ChatGPT.
 */

export const SERVER_INFO = {
  name: "spendboundary",
  version: "2.1.0",
  title: "SpendBoundary — Policy-Gated Agentic Commerce Gateway",
} as const;

export const PROTOCOL_VERSION = "2024-11-05";

export const TOOLS = [
  {
    name: "search_catalogue",
    description:
      "Search the merchant catalogue. Returns live stock and authoritative integer paise prices. Prices returned here are the only prices the gateway will honour.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free text search over name, description and category." },
        category: { type: "string", description: "Optional exact category filter." },
        limit: { type: "integer", description: "Max results (default 20).", minimum: 1, maximum: 50 },
      },
      required: [],
    },
  },
  {
    name: "get_product",
    description: "Fetch a single catalogue product by SKU, including its category and stock.",
    inputSchema: {
      type: "object",
      properties: { sku: { type: "string" } },
      required: ["sku"],
    },
  },
  {
    name: "get_policy_limits",
    description:
      "Fetch the merchant spend policy, the remaining 24h budget, and the tokenized card mandate status. If no card is stored, this returns a one-time ₹1 setup link to give the user.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "request_checkout",
    description:
      "Submit a cart for deterministic policy evaluation and execution. The server re-prices every line from its own database, so any price you supply is ignored. Returns ALLOW (charged with zero OTP), REVIEW (hosted payment link for the human) or DENY (blocked). Never call this twice for the same cart — use check_approval_status instead.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Line items to purchase.",
          items: {
            type: "object",
            properties: {
              sku: { type: "string" },
              quantity: { type: "integer", minimum: 1 },
              claimedPricePaise: {
                type: "integer",
                description: "Optional. Recorded for audit, never trusted.",
              },
            },
            required: ["sku", "quantity"],
          },
        },
        reason: { type: "string", description: "Why the user wants this purchase." },
        agentId: { type: "string", description: "Stable id for the calling agent." },
        simulateTimeout: {
          type: "boolean",
          description: "Test hook: force an ambiguous gateway status to exercise the quarantine.",
        },
      },
      required: ["items", "reason"],
    },
  },
  {
    name: "check_approval_status",
    description:
      "Poll a previously submitted request. Reconciles hosted payment links against the gateway and reports whether a quarantined debit has resolved. Call this instead of retrying a checkout.",
    inputSchema: {
      type: "object",
      properties: { requestId: { type: "string" } },
      required: ["requestId"],
    },
  },
  {
    name: "cancel_request",
    description: "Cancel a pending human-review request that the user no longer wants.",
    inputSchema: {
      type: "object",
      properties: { requestId: { type: "string" } },
      required: ["requestId"],
    },
  },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  switch (name) {
    case "search_catalogue":
      return searchCatalogue(args);
    case "get_product":
      return getProduct(String(args.sku ?? ""));
    case "get_policy_limits":
      return getPolicyLimits();
    case "request_checkout":
      return requestCheckout({
        items: (args.items as { sku: string; quantity: number }[]) ?? [],
        reason: String(args.reason ?? ""),
        agentId: args.agentId ? String(args.agentId) : undefined,
        simulateTimeout: Boolean(args.simulateTimeout),
      });
    case "check_approval_status":
      return checkApprovalStatus(String(args.requestId ?? ""));
    case "cancel_request":
      return cancelRequest(String(args.requestId ?? ""));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function searchCatalogue(args: Record<string, unknown>) {
  const query = String(args.query ?? "").trim();
  const category = args.category ? String(args.category) : undefined;
  const limit = Math.min(Number(args.limit ?? 20) || 20, 50);

  const all = await prisma.product.findMany({ orderBy: { pricePaise: "asc" } });
  const needle = query.toLowerCase();
  const results = all
    .filter((product) => (category ? product.category === category : true))
    .filter((product) =>
      needle
        ? `${product.name} ${product.description} ${product.category} ${product.sku}`
            .toLowerCase()
            .includes(needle)
        : true,
    )
    .slice(0, limit);

  const policy = await getPolicyConfig();
  return {
    count: results.length,
    products: results.map((product) => ({
      sku: product.sku,
      name: product.name,
      description: product.description,
      category: product.category,
      pricePaise: product.pricePaise,
      priceFormatted: formatPaise(product.pricePaise),
      stock: product.stock,
      categoryWhitelisted: policy.allowedCategories.includes(product.category),
    })),
    note: "Prices are integer paise and are re-verified server-side at checkout.",
  };
}

async function getProduct(sku: string) {
  const product = await prisma.product.findUnique({ where: { sku } });
  if (!product) return { found: false, sku, message: "No such SKU in the merchant catalogue." };
  const policy = await getPolicyConfig();
  return {
    found: true,
    sku: product.sku,
    name: product.name,
    description: product.description,
    category: product.category,
    pricePaise: product.pricePaise,
    priceFormatted: formatPaise(product.pricePaise),
    stock: product.stock,
    categoryWhitelisted: policy.allowedCategories.includes(product.category),
  };
}

export async function getPolicyLimits() {
  const policy = await getPolicyConfig();
  const dailySpentPaise = await getDailySpentPaise();
  let mandate = toMandateView(await getMandateRecord());
  if (mandate.status !== "ACTIVE") {
    mandate = await getOrCreateMandateSetupLink();
  }

  return {
    gatewayMode: gatewayMode(),
    limits: {
      approvalThresholdPaise: policy.approvalThresholdPaise,
      approvalThresholdFormatted: formatPaise(policy.approvalThresholdPaise),
      maxOrderPaise: policy.maxOrderPaise,
      maxOrderFormatted: formatPaise(policy.maxOrderPaise),
      dailyCapPaise: policy.dailyCapPaise,
      dailyCapFormatted: formatPaise(policy.dailyCapPaise),
      velocity: `${policy.velocityMaxRequests} requests / ${policy.velocityWindowSec}s, ${policy.velocityLockoutSec}s lockout`,
    },
    allowedCategories: policy.allowedCategories,
    spend: {
      dailySpentPaise,
      dailySpentFormatted: formatPaise(dailySpentPaise),
      remainingPaise: Math.max(policy.dailyCapPaise - dailySpentPaise, 0),
      remainingFormatted: formatPaise(Math.max(policy.dailyCapPaise - dailySpentPaise, 0)),
    },
    mandate,
    zones: {
      ALLOW: `< ${formatPaise(policy.approvalThresholdPaise)} — autonomous zero-OTP debit`,
      REVIEW: `${formatPaise(policy.approvalThresholdPaise)} – ${formatPaise(policy.maxOrderPaise)} — hosted payment link, human authorizes`,
      DENY: `> ${formatPaise(policy.maxOrderPaise)}, non-whitelisted category, daily cap or velocity breach`,
    },
  };
}

async function cancelRequest(requestId: string) {
  const request = await prisma.agentRequest.findUnique({
    where: { id: requestId },
    include: { approval: true },
  });
  if (!request) return { cancelled: false, requestId, message: "No such request id." };
  if (request.status === "PAID") {
    return { cancelled: false, requestId, message: "Request already captured; cannot cancel." };
  }
  if (request.status === "DEBIT_IN_PROGRESS") {
    return {
      cancelled: false,
      requestId,
      message: "Request is quarantined pending reconciliation and cannot be cancelled by an agent.",
    };
  }
  if (request.approval) {
    await prisma.approval.update({
      where: { requestId },
      data: { status: "REJECTED", decidedAt: new Date(), decidedBy: "agent_cancel" },
    });
  }
  await prisma.agentRequest.update({ where: { id: requestId }, data: { status: "CANCELLED" } });
  await appendAuditEvent("APPROVAL_SUBMITTED", { kind: "AGENT_CANCELLED" }, requestId);
  return { cancelled: true, requestId, status: "CANCELLED" };
}

/** JSON-RPC 2.0 dispatcher shared by the HTTP endpoint and the stdio server. */
export async function handleJsonRpc(message: {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}): Promise<Record<string, unknown> | null> {
  const { id = null, method, params = {} } = message;

  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, msg: string) => ({ jsonrpc: "2.0", id, error: { code, message: msg } });

  try {
    switch (method) {
      case "initialize":
        return ok({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
      case "notifications/initialized":
        return null; // notification, no response
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS });
      case "tools/call": {
        const name = String(params.name ?? "");
        const args = (params.arguments as Record<string, unknown>) ?? {};
        const result = await callTool(name, args);
        return ok({
          content: [{ type: "text", text: JSON.stringify(result, jsonSafe, 2) }],
          isError: false,
        });
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (error) {
    return fail(-32000, (error as Error).message);
  }
}

/** BigInt columns (epochTimestamp) are not JSON serializable by default. */
export function jsonSafe(_key: string, value: unknown) {
  return typeof value === "bigint" ? Number(value) : value;
}
