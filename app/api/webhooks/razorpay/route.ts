import { NextResponse } from "next/server";
import { verifyWebhookSignature, validateRazorpayResponse } from "@/lib/razorpay";
import { markApprovalPaid } from "@/lib/checkout";
import { activateMandate, getMandateRecord } from "@/lib/mandate";
import { appendAuditEvent } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || "spendboundary_demo_secret";
  const signature = request.headers.get("x-razorpay-signature");

  try {
    const rawBody = await request.text();

    if (!signature) {
      await appendAuditEvent("GATEWAY_SECURITY_ALERT", {
        reason: "MISSING_WEBHOOK_SIGNATURE",
        message: "Inbound webhook missing x-razorpay-signature header",
      });
      return NextResponse.json({ error: "Missing x-razorpay-signature header" }, { status: 400 });
    }

    // 1. Verify webhook signature
    const isValidSignature = verifyWebhookSignature(rawBody, signature, webhookSecret);
    if (!isValidSignature) {
      await appendAuditEvent("GATEWAY_SECURITY_ALERT", {
        reason: "INVALID_WEBHOOK_SIGNATURE",
        signature,
        message: "Webhook HMAC signature mismatch",
      });
      return NextResponse.json({ error: "Invalid webhook signature" }, { status: 400 });
    }

    const payload = JSON.parse(rawBody);

    // 2. Verify timestamp freshness (5 min window)
    const eventTimeMs = payload.created_at ? payload.created_at * 1000 : Date.now();
    const isFresh = validateRazorpayResponse(
      {
        data: payload,
        timestamp: eventTimeMs,
      },
      webhookSecret,
      { maxAgeMs: 5 * 60 * 1000 },
    );

    if (!isFresh) {
      await appendAuditEvent("GATEWAY_SECURITY_ALERT", {
        reason: "REPLAY_ATTACK_PREVENTED",
        eventTimestamp: eventTimeMs,
        message: "Webhook timestamp is outside the 5-minute freshness window",
      });
      return NextResponse.json({ error: "Webhook timestamp expired or outside freshness window" }, { status: 400 });
    }

    await appendAuditEvent("WEBHOOK_RECEIVED", {
      event: payload.event,
      eventId: payload.event_id || request.headers.get("x-razorpay-event-id"),
      entity: payload.payload?.payment?.entity?.id || payload.payload?.payment_link?.entity?.id,
    });

    // 3. Process known webhook event types
    const eventType = String(payload.event ?? "");

    // Payment Link Paid -> Reconcile Human Review or Mandate Setup
    if (eventType === "payment_link.paid") {
      const plink = payload.payload?.payment_link?.entity;
      const payment = payload.payload?.payment?.entity;
      const referenceId = String(plink?.reference_id ?? "");

      if (referenceId.startsWith("mandate_setup_")) {
        await activateMandate({
          cardNetwork: payment?.card?.network ?? "Card",
          cardLast4: payment?.card?.last4 ?? "0000",
          tokenId: payment?.token_id ?? payment?.id,
          customerId: payment?.customer_id ?? null,
        });
      } else if (referenceId.startsWith("req_")) {
        await markApprovalPaid(referenceId, payment?.id, "razorpay_webhook");
      }
    }

    return NextResponse.json({ ok: true, received: true, event: payload.event });
  } catch (error) {
    await appendAuditEvent("GATEWAY_SECURITY_ALERT", {
      reason: "WEBHOOK_PROCESSING_EXCEPTION",
      error: (error as Error).message,
    });
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
