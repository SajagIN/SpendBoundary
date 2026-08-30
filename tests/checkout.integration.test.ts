import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import { requestCheckout, checkApprovalStatus, getDailySpentPaise } from "../lib/checkout";
import { simulateMandateAuthorization, revokeMandate } from "../lib/mandate";
import { loadAndVerifyChain } from "../lib/audit";

const CATALOGUE = [
  { sku: "SKU-NOTE-350", name: "Notebook", description: "d", category: "Office Supplies", pricePaise: 35_000, stock: 100 },
  { sku: "SKU-LAMP-1500", name: "Smart Desk Lamp", description: "d", category: "Home Office", pricePaise: 150_000, stock: 30 },
  { sku: "SKU-CHAIR-8000", name: "Ergonomic Chair", description: "d", category: "Furniture", pricePaise: 800_000, stock: 10 },
  { sku: "SKU-MINER-5000", name: "Mining Licence", description: "d", category: "Crypto", pricePaise: 500_000, stock: 5 },
  { sku: "SKU-PEN-120", name: "Gel Pens", description: "d", category: "Office Supplies", pricePaise: 12_000, stock: 300 },
];

let agentCounter = 0;
/** Each test gets a fresh agent id so the velocity window never leaks across tests. */
function nextAgent() {
  agentCounter += 1;
  return `agent_test_${agentCounter}`;
}

beforeAll(async () => {
  await prisma.policy.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  await prisma.paymentMandate.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default" },
  });
  for (const product of CATALOGUE) {
    await prisma.product.upsert({ where: { sku: product.sku }, update: product, create: product });
  }
});

beforeEach(async () => {
  await prisma.paymentAttempt.deleteMany();
  await prisma.approval.deleteMany();
  await prisma.policyDecision.deleteMany();
  await prisma.agentRequest.deleteMany();
  await simulateMandateAuthorization();
});

describe("end-to-end policy-gated checkout", () => {
  it("AC-01: debits a ₹350 notebook with zero OTP prompts", async () => {
    const result = await requestCheckout({
      agentId: nextAgent(),
      reason: "Notebook for meeting notes",
      items: [{ sku: "SKU-NOTE-350", quantity: 1 }],
    });

    expect(result.decision).toBe("ALLOW");
    expect(result.paymentStatus).toBe("PAID");
    expect(result.amountPaise).toBe(35_000);
    expect(result.orderId).toMatch(/^order_/);
    expect(result.paymentId).toMatch(/^pay_/);
    expect(result.telemetry.debitedAt).toBeTruthy();
    expect(await getDailySpentPaise()).toBe(35_000);
  });

  it("discards a hallucinated price and charges the database price", async () => {
    const result = await requestCheckout({
      agentId: nextAgent(),
      reason: "Agent claims the lamp costs ₹1",
      items: [{ sku: "SKU-LAMP-1500", quantity: 1, claimedPricePaise: 100 }],
    });

    expect(result.amountPaise).toBe(150_000);
    expect(result.decision).toBe("REVIEW");
  });

  it("AC-02: halts a ₹1,500 lamp and issues a hosted payment link", async () => {
    const result = await requestCheckout({
      agentId: nextAgent(),
      reason: "Smart desk lamp",
      items: [{ sku: "SKU-LAMP-1500", quantity: 1 }],
    });

    expect(result.decision).toBe("REVIEW");
    expect(result.paymentStatus).toBe("AWAITING_HUMAN_APPROVAL");
    expect(result.paymentLinkUrl).toMatch(/^https:\/\/rzp\.io\//);
    expect(result.paymentId).toBeUndefined();

    const approval = await prisma.approval.findUnique({ where: { requestId: result.requestId } });
    expect(approval?.status).toBe("PENDING");
    expect(await getDailySpentPaise()).toBe(0);
  });

  it("AC-03: denies a non-whitelisted category with zero gateway calls", async () => {
    const result = await requestCheckout({
      agentId: nextAgent(),
      reason: "Crypto mining licence",
      items: [{ sku: "SKU-MINER-5000", quantity: 1 }],
    });

    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe("CATEGORY_NOT_ALLOWED");
    expect(result.paymentStatus).toBe("BLOCKED");
    expect(result.paymentLinkUrl).toBeUndefined();
    expect(await prisma.paymentAttempt.count()).toBe(0);
  });

  it("denies an ₹8,000 chair that breaches the single-order cap", async () => {
    const result = await requestCheckout({
      agentId: nextAgent(),
      reason: "Ergonomic chair",
      items: [{ sku: "SKU-CHAIR-8000", quantity: 1 }],
    });

    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe("ORDER_CAP_EXCEEDED");
  });

  it("AC-04: trips the velocity breaker on the fourth request in the window", async () => {
    const agentId = nextAgent();
    const decisions: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const result = await requestCheckout({
        agentId,
        reason: `burst ${index}`,
        items: [{ sku: "SKU-PEN-120", quantity: index + 1 }],
      });
      decisions.push(result.reasonCode);
    }

    expect(decisions.slice(0, 3).every((code) => code === "WITHIN_AUTONOMOUS_LIMIT")).toBe(true);
    expect(decisions[3]).toBe("VELOCITY_LIMIT_EXCEEDED");

    // The 15 minute lockout keeps denying afterwards.
    const afterLock = await requestCheckout({
      agentId,
      reason: "still locked",
      items: [{ sku: "SKU-PEN-120", quantity: 9 }],
    });
    expect(afterLock.reasonCode).toBe("CIRCUIT_BREAKER_ACTIVE");
  });

  it("AC-05: quarantines an ambiguous debit and blocks the duplicate retry", async () => {
    const agentId = nextAgent();
    const first = await requestCheckout({
      agentId,
      reason: "Notebook with a flaky gateway",
      items: [{ sku: "SKU-NOTE-350", quantity: 1 }],
      simulateTimeout: true,
    });

    expect(first.paymentStatus).toBe("DEBIT_IN_PROGRESS");
    expect(first.reasonCode).toBe("QUARANTINED_PENDING_RECONCILIATION");

    // The agent panics and re-submits the identical cart.
    const retry = await requestCheckout({
      agentId,
      reason: "Notebook with a flaky gateway",
      items: [{ sku: "SKU-NOTE-350", quantity: 1 }],
    });

    expect(retry.requestId).toBe(first.requestId);
    expect(retry.paymentStatus).toBe("QUARANTINED_PENDING_RECONCILIATION");
    expect(retry.reasonCode).toBe("QUARANTINE_LOCKED");

    // Exactly one attempt exists and nothing was captured.
    expect(await prisma.paymentAttempt.count()).toBe(1);
    expect(await getDailySpentPaise()).toBe(0);

    const status = await checkApprovalStatus(first.requestId);
    expect(status.paymentStatus).toBe("QUARANTINED_PENDING_RECONCILIATION");
  });

  it("deduplicates an identical successful cart instead of charging twice", async () => {
    const agentId = nextAgent();
    const cart = [{ sku: "SKU-NOTE-350", quantity: 2 }];
    const first = await requestCheckout({ agentId, reason: "two notebooks", items: cart });
    const second = await requestCheckout({ agentId, reason: "two notebooks", items: cart });

    expect(first.paymentStatus).toBe("PAID");
    expect(second.paymentStatus).toBe("RETRY_DEDUPLICATED");
    expect(second.requestId).toBe(first.requestId);
    expect(await getDailySpentPaise()).toBe(70_000);
  });

  it("requires the ₹1 mandate before any autonomous debit", async () => {
    await revokeMandate();
    const result = await requestCheckout({
      agentId: nextAgent(),
      reason: "Notebook without a card on file",
      items: [{ sku: "SKU-NOTE-350", quantity: 1 }],
    });

    expect(result.decision).toBe("ALLOW");
    expect(result.paymentStatus).toBe("MANDATE_REQUIRED");
    expect(result.paymentLinkUrl).toMatch(/^https:\/\/rzp\.io\//);
    expect(await getDailySpentPaise()).toBe(0);
  });

  it("reconciles an approved review into a captured payment", async () => {
    const review = await requestCheckout({
      agentId: nextAgent(),
      reason: "Smart desk lamp",
      items: [{ sku: "SKU-LAMP-1500", quantity: 1 }],
    });
    const { markApprovalPaid } = await import("../lib/checkout");
    await markApprovalPaid(review.requestId, "pay_manual_test", "merchant_console");

    const status = await checkApprovalStatus(review.requestId);
    expect(status.status).toBe("PAID");
    expect(await getDailySpentPaise()).toBe(150_000);
  });

  it("seals every step into a verifiable audit chain", async () => {
    await requestCheckout({
      agentId: nextAgent(),
      reason: "Notebook",
      items: [{ sku: "SKU-NOTE-350", quantity: 1 }],
    });

    const { events, verification } = await loadAndVerifyChain();
    const types = events.map((event) => event.eventType);
    expect(verification.valid).toBe(true);
    expect(types).toContain("AGENT_REQUEST");
    expect(types).toContain("POLICY_DECISION_EVALUATED");
    expect(types).toContain("MANDATE_AUTO_DEBIT_CAPTURED");
  });

  it("reports an unknown SKU without touching the gateway", async () => {
    const result = await requestCheckout({
      agentId: nextAgent(),
      reason: "Hallucinated product",
      items: [{ sku: "SKU-DOES-NOT-EXIST", quantity: 1 }],
    });

    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe("UNKNOWN_SKU");
    expect(result.rejectedItems[0].problem).toMatch(/not found/);
  });
});
