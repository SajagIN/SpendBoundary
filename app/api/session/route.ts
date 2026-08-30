import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import {
  createSessionBinding,
  getSessionBinding,
  revokeSession,
  generateSessionHash,
} from "@/lib/session";
import { jsonSafe } from "@/lib/mcp";

export const dynamic = "force-dynamic";

function defaultFingerprint(ip: string, ua: string): string {
  return createHash("sha256").update(`${ip}:${ua}`).digest("hex");
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const headers = request.headers;

    const forwardedFor = headers.get("x-forwarded-for");
    const headerIp = forwardedFor ? forwardedFor.split(",")[0].trim() : headers.get("x-real-ip");
    const ipAddress = String(body.ipAddress || headerIp || "127.0.0.1");

    const headerUa = headers.get("user-agent");
    const userAgent = String(body.userAgent || headerUa || "SpendBoundary-Agent/1.0");

    const headerCountry = headers.get("cf-ipcountry") || headers.get("x-country");
    const country = body.country ? String(body.country) : headerCountry ? String(headerCountry) : null;

    const headerFingerprint = headers.get("x-device-fingerprint");
    const deviceFingerprint = String(
      body.deviceFingerprint || headerFingerprint || defaultFingerprint(ipAddress, userAgent),
    );

    const agentId = String(body.agentId || "agent_demo_console");

    const session = await createSessionBinding({
      sessionId: body.sessionId ? String(body.sessionId) : undefined,
      agentId,
      ipAddress,
      country,
      userAgent,
      deviceFingerprint,
      durationHours: body.durationHours ? Number(body.durationHours) : undefined,
      maxTransactionValue: body.maxTransactionValue ? Number(body.maxTransactionValue) : undefined,
      maxDailySpend: body.maxDailySpend ? Number(body.maxDailySpend) : undefined,
    });

    const sessionHash = generateSessionHash({
      sessionId: session.sessionId,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      deviceFingerprint: session.deviceFingerprint,
      timestamp: session.createdAt.getTime(),
    });

    return new NextResponse(JSON.stringify({ ok: true, session, sessionHash }, jsonSafe), {
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId =
      searchParams.get("sessionId") || request.headers.get("x-session-id");

    if (!sessionId) {
      return NextResponse.json({ error: "sessionId query param or x-session-id header required" }, { status: 400 });
    }

    const session = await getSessionBinding(sessionId);
    if (!session) {
      return NextResponse.json({ ok: false, message: "Session not found" }, { status: 404 });
    }

    const isExpired = session.expiresAt.getTime() < Date.now() || Boolean(session.revokedAt);

    return new NextResponse(
      JSON.stringify({ ok: true, session, active: !isExpired }, jsonSafe),
      { headers: { "content-type": "application/json" } },
    );
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { searchParams } = new URL(request.url);
    const sessionId = String(body.sessionId || searchParams.get("sessionId") || "");

    if (!sessionId) {
      return NextResponse.json({ error: "sessionId required to revoke session" }, { status: 400 });
    }

    const session = await revokeSession(sessionId, String(body.reason || "EXPLICIT_REVOCATION"));
    return new NextResponse(JSON.stringify({ ok: true, session, status: "REVOKED" }, jsonSafe), {
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
