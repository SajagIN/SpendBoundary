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

    const headers = request.headers;
    const sessionId =
      body.sessionId || body.sessionContext?.sessionId || headers.get("x-session-id");

    let sessionContext = body.sessionContext;
    if (sessionId && !sessionContext) {
      const forwardedFor = headers.get("x-forwarded-for");
      const ipAddress = forwardedFor ? forwardedFor.split(",")[0].trim() : headers.get("x-real-ip") || "127.0.0.1";
      const userAgent = headers.get("user-agent") || "SpendBoundary-Agent/1.0";
      const country = headers.get("cf-ipcountry") || headers.get("x-country") || null;
      const deviceFingerprint = headers.get("x-device-fingerprint") || "";

      sessionContext = {
        sessionId: String(sessionId),
        agentId: body.agentId ? String(body.agentId) : undefined,
        ipAddress: String(ipAddress),
        country: country ? String(country) : null,
        userAgent: String(userAgent),
        deviceFingerprint: String(deviceFingerprint),
        timestamp: Date.now(),
      };
    }

    const result = await requestCheckout({
      items: body.items,
      reason: String(body.reason ?? "Agent checkout"),
      agentId: body.agentId ? String(body.agentId) : undefined,
      simulateTimeout: Boolean(body.simulateTimeout),
      sessionId: sessionId ? String(sessionId) : undefined,
      sessionContext,
    });
    return new NextResponse(JSON.stringify(result, jsonSafe), {
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
