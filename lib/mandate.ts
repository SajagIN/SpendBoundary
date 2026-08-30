import { prisma } from "./prisma";
import { appendAuditEvent } from "./audit";
import { razorpayGateway, isLiveMode } from "./razorpay";

/**
 * F1 / R-05 — consolidated consent through a one-time ₹1 verification link.
 *
 * Incident E09: webhooks cannot reach a local dev machine, so this module
 * actively reconciles the setup link against the Razorpay API every time the
 * mandate is read instead of waiting for an inbound callback.
 */

export const MANDATE_SETUP_PAISE = 100; // ₹1 verification fee

export type MandateView = {
  status: "NO_CARD_STORED" | "PENDING_AUTHORIZATION" | "ACTIVE" | "REVOKED";
  cardNetwork: string | null;
  cardLast4: string | null;
  tokenId: string | null;
  customerId: string | null;
  maxDebitPaise: number;
  setupLinkUrl: string | null;
  activatedAt: string | null;
  label: string;
};

export async function getMandateRecord() {
  const existing = await prisma.paymentMandate.findUnique({ where: { id: "default" } });
  if (existing) return existing;
  return prisma.paymentMandate.create({ data: { id: "default" } });
}

export function toMandateView(record: Awaited<ReturnType<typeof getMandateRecord>>): MandateView {
  return {
    status: record.status as MandateView["status"],
    cardNetwork: record.cardNetwork,
    cardLast4: record.cardLast4,
    tokenId: record.tokenId,
    customerId: record.customerId,
    maxDebitPaise: record.maxDebitPaise,
    setupLinkUrl: record.setupLinkUrl,
    activatedAt: record.activatedAt?.toISOString() ?? null,
    label:
      record.status === "ACTIVE" && record.cardNetwork
        ? `${record.cardNetwork} •••• ${record.cardLast4}`
        : record.status === "PENDING_AUTHORIZATION"
          ? "Awaiting ₹1 authorization"
          : "No card stored",
  };
}

/**
 * Returns the active mandate, or creates/reuses a ₹1 hosted setup link.
 * Always reconciles against the gateway first (Incident E09).
 */
export async function getOrCreateMandateSetupLink(): Promise<MandateView> {
  let record = await getMandateRecord();

  if (record.status === "ACTIVE") {
    return toMandateView(record);
  }

  // Active reconciliation: has the user already paid the ₹1 link?
  if (record.setupLinkId && isLiveMode()) {
    try {
      const link = await razorpayGateway.fetchPaymentLink(record.setupLinkId);
      if (link.status === "paid" && link.paymentId) {
        const payment = await razorpayGateway.fetchPayment(link.paymentId);
        // A captured ₹1 payment is NOT proof of a reusable mandate. If Razorpay
        // returned no token_id (recurring not enabled, or the link was not an
        // authorization transaction) then there is nothing to debit later.
        // Falling back to the payment id here would mint an ACTIVE mandate that
        // can never be charged — Incident E08 all over again.
        if (payment.tokenId) {
          record = await activateMandate({
            cardNetwork: payment.cardNetwork ?? "Card",
            cardLast4: payment.cardLast4 ?? "0000",
            tokenId: payment.tokenId,
            customerId: payment.customerId ?? null,
          });
        }
        return toMandateView(record);
      }
    } catch (error) {
      console.warn("Failed to reconcile existing mandate setup link from gateway:", error);
      // The setup link ID in DB might be from mock mode, expired, or on another account.
      // Reset the invalid setupLinkId so a fresh link can be generated.
      record = await prisma.paymentMandate.update({
        where: { id: "default" },
        data: {
          setupLinkId: null,
          setupLinkUrl: null,
          status: "PENDING_AUTHORIZATION",
        },
      });
    }
  }

  if (!record.setupLinkId) {
    try {
      const link = await razorpayGateway.createPaymentLink({
        amountPaise: MANDATE_SETUP_PAISE,
        description: "SpendBoundary — one-time ₹1 mandate verification",
        referenceId: `mandate_setup_${Date.now()}`,
        saveCard: true,
      });
      record = await prisma.paymentMandate.update({
        where: { id: "default" },
        data: {
          status: "PENDING_AUTHORIZATION",
          setupLinkId: link.linkId,
          setupLinkUrl: link.shortUrl,
        },
      });
      await appendAuditEvent("APPROVAL_SUBMITTED", {
        kind: "MANDATE_SETUP_LINK_CREATED",
        linkId: link.linkId,
        shortUrl: link.shortUrl,
        amountPaise: MANDATE_SETUP_PAISE,
        simulated: link.simulated,
      });
    } catch (error) {
      console.error("Failed to create mandate setup link from gateway:", error);
      return toMandateView(record);
    }
  }

  return toMandateView(record);
}

export async function activateMandate(input: {
  cardNetwork: string;
  cardLast4: string;
  tokenId: string;
  customerId: string | null;
}) {
  await getMandateRecord();
  const record = await prisma.paymentMandate.update({
    where: { id: "default" },
    data: {
      status: "ACTIVE",
      cardNetwork: input.cardNetwork,
      cardLast4: input.cardLast4,
      tokenId: input.tokenId,
      customerId: input.customerId,
      activatedAt: new Date(),
    },
  });
  await appendAuditEvent("PAYMENT_MANDATE_ACTIVATED", {
    cardNetwork: input.cardNetwork,
    cardLast4: input.cardLast4,
    tokenId: input.tokenId,
    maxDebitPaise: record.maxDebitPaise,
  });
  return record;
}

/**
 * Offline-demo shortcut standing in for the user completing the ₹1 link.
 *
 * Refused whenever real Razorpay credentials are configured. Fabricating a
 * mandate against a live account produced Incident E08: the dashboard showed
 * an ACTIVE card, checkouts reported success, and no money ever moved. With
 * live keys the mandate may only become ACTIVE by reconciling a genuinely
 * captured ₹1 payment.
 */
export async function simulateMandateAuthorization() {
  if (isLiveMode()) {
    throw new Error(
      "Refusing to fabricate a card mandate while live Razorpay keys are configured. Pay the ₹1 setup link, then use the refresh action to reconcile the real token.",
    );
  }
  const record = await getMandateRecord();
  const linkId = record.setupLinkId ?? `plink_demo_${Date.now()}`;
  const payment = razorpayGateway.mockCapture(linkId);
  return activateMandate({
    cardNetwork: payment.cardNetwork ?? "RuPay",
    cardLast4: payment.cardLast4 ?? "1005",
    tokenId: payment.tokenId ?? payment.paymentId,
    customerId: payment.customerId ?? null,
  });
}

export async function revokeMandate() {
  await getMandateRecord();
  return prisma.paymentMandate.update({
    where: { id: "default" },
    data: {
      status: "NO_CARD_STORED",
      cardNetwork: null,
      cardLast4: null,
      tokenId: null,
      customerId: null,
      setupLinkId: null,
      setupLinkUrl: null,
      activatedAt: null,
    },
  });
}
