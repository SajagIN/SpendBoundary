import { NextResponse } from "next/server";
import {
  getOrCreateMandateSetupLink,
  simulateMandateAuthorization,
  revokeMandate,
  toMandateView,
  getMandateRecord,
} from "@/lib/mandate";
import { gatewayMode } from "@/lib/razorpay";

export const dynamic = "force-dynamic";

export async function GET() {
  const mandate = await getOrCreateMandateSetupLink();
  return NextResponse.json({ mandate, gatewayMode: gatewayMode() });
}

/**
 * `authorize` stands in for the user completing the ₹1 hosted link.
 * In live mode the identical transition happens through active reconciliation
 * inside getOrCreateMandateSetupLink (Incident E09).
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const action = String(body.action ?? "");

  if (action === "authorize") {
    try {
      const record = await simulateMandateAuthorization();
      return NextResponse.json({ ok: true, mandate: toMandateView(record) });
    } catch (error) {
      return NextResponse.json(
        { error: (error as Error).message, mandate: await getOrCreateMandateSetupLink() },
        { status: 409 },
      );
    }
  }
  if (action === "revoke") {
    const record = await revokeMandate();
    return NextResponse.json({ ok: true, mandate: toMandateView(record) });
  }
  if (action === "refresh") {
    await getMandateRecord();
    return NextResponse.json({ ok: true, mandate: await getOrCreateMandateSetupLink() });
  }
  return NextResponse.json({ error: "action must be authorize, revoke or refresh" }, { status: 400 });
}
