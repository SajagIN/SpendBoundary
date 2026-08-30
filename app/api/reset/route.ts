import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { appendAuditEvent } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * Dashboard "Reset Spend" control. Clears the transactional tables so the
 * 24h rolling spend and velocity window start clean; the policy, catalogue and
 * mandate survive. Pass { wipeLedger: true } to also clear the audit chain.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));

  await prisma.paymentAttempt.deleteMany();
  await prisma.approval.deleteMany();
  await prisma.policyDecision.deleteMany();
  await prisma.agentRequest.deleteMany();

  if (body.wipeLedger === true) {
    await prisma.auditEvent.deleteMany();
  }

  await appendAuditEvent("SPEND_RESET", {
    scope: body.wipeLedger === true ? "TRANSACTIONS_AND_LEDGER" : "TRANSACTIONS_ONLY",
    resetAt: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true, dailySpentPaise: 0 });
}
