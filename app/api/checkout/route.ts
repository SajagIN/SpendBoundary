import { NextResponse } from "next/server";
import { requestCheckout } from "@/lib/checkout";
import { jsonSafe } from "@/lib/mcp";

export const dynamic = "force-dynamic";

/**
 * REST twin of the `request_checkout` MCP tool, used by the dashboard console
 * and by ChatGPT Custom GPT Actions (see public/openapi.json).
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!Array.isArray(body?.items) || body.items.length === 0) {
      return NextResponse.json({ error: "items[] is required" }, { status: 400 });
    }
    const result = await requestCheckout({
      items: body.items,
      reason: String(body.reason ?? "Agent checkout"),
      agentId: body.agentId ? String(body.agentId) : undefined,
      simulateTimeout: Boolean(body.simulateTimeout),
    });
    return new NextResponse(JSON.stringify(result, jsonSafe), {
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
