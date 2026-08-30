import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { markApprovalPaid, rejectApproval } from "@/lib/checkout";
import { formatPaise } from "@/lib/money";

export const dynamic = "force-dynamic";

export async function GET() {
  const approvals = await prisma.approval.findMany({
    orderBy: { createdAt: "desc" },
    include: { request: { include: { decision: true } } },
    take: 50,
  });

  return NextResponse.json({
    pendingCount: approvals.filter((approval) => approval.status === "PENDING").length,
    approvals: approvals.map((approval) => ({
      requestId: approval.requestId,
      status: approval.status,
      amountPaise: approval.amountPaise,
      amountFormatted: formatPaise(approval.amountPaise),
      paymentLinkUrl: approval.paymentLinkUrl,
      createdAt: approval.createdAt.toISOString(),
      decidedAt: approval.decidedAt?.toISOString() ?? null,
      decidedBy: approval.decidedBy,
      agentId: approval.request.agentId,
      reason: approval.request.reason,
      items: JSON.parse(approval.request.itemsJson) as unknown[],
      reasonCode: approval.request.decision?.reasonCode ?? null,
      reasonText: approval.request.decision?.reasonText ?? null,
    })),
  });
}

/** Merchant override: approve executes the held payment, reject kills it. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const requestId = String(body.requestId ?? "");
  const action = String(body.action ?? "");

  if (!requestId) return NextResponse.json({ error: "requestId is required" }, { status: 400 });

  try {
    if (action === "approve") {
      await markApprovalPaid(requestId, undefined, "merchant_console");
    } else if (action === "reject") {
      await rejectApproval(requestId, "merchant_console");
    } else {
      return NextResponse.json({ error: "action must be approve or reject" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, requestId, action });
}
