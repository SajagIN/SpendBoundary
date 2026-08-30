import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { loadAndVerifyChain, appendAuditEvent, GENESIS_HASH } from "@/lib/audit";

export const dynamic = "force-dynamic";

const TAMPER_MARKER = "__tamperedByDemo";

export async function GET() {
  const { events, verification } = await loadAndVerifyChain();
  return NextResponse.json({
    genesisHash: GENESIS_HASH,
    verification,
    events: events.map((event) => ({
      index: event.index,
      eventType: event.eventType,
      requestId: event.requestId,
      payload: JSON.parse(event.payloadJson) as unknown,
      previousHash: event.previousHash,
      eventHash: event.eventHash,
      createdAt: event.createdAt,
      tampered: event.payloadJson.includes(TAMPER_MARKER),
    })),
  });
}

/**
 * AC-06 — deliberately mutate a historical row so the chain verifier reports
 * the exact broken block. `restore` puts the original payload back, which
 * makes every hash line up again (nothing was re-signed).
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const action = String(body.action ?? "tamper");

  if (action === "restore") {
    const tampered = await prisma.auditEvent.findMany();
    let restored = 0;
    for (const event of tampered) {
      if (!event.payloadJson.includes(TAMPER_MARKER)) continue;
      const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
      delete payload[TAMPER_MARKER];
      await prisma.auditEvent.update({
        where: { id: event.id },
        data: { payloadJson: JSON.stringify(payload) },
      });
      restored += 1;
    }
    const { verification } = await loadAndVerifyChain();
    return NextResponse.json({ ok: true, restored, verification });
  }

  const target =
    (await prisma.auditEvent.findFirst({ orderBy: { index: "asc" }, skip: 1 })) ??
    (await prisma.auditEvent.findFirst({ orderBy: { index: "asc" } }));

  if (!target) {
    return NextResponse.json(
      { error: "Ledger is empty — run a checkout first, then simulate tampering." },
      { status: 400 },
    );
  }

  const payload = JSON.parse(target.payloadJson) as Record<string, unknown>;
  payload[TAMPER_MARKER] = "amountPaise silently rewritten by an attacker";
  await prisma.auditEvent.update({
    where: { id: target.id },
    data: { payloadJson: JSON.stringify(payload) },
  });

  const { verification } = await loadAndVerifyChain();
  await appendAuditEvent("TAMPER_DETECTED", {
    tamperedIndex: target.index,
    detectedAtIndex: verification.brokenIndex,
    reason: verification.reason,
  });

  const after = await loadAndVerifyChain();
  return NextResponse.json({ ok: true, tamperedIndex: target.index, verification: after.verification });
}
