import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma";
import {
  createSessionBinding,
  generateSessionHash,
  getSessionBinding,
  revokeSession,
  validateSessionContext,
} from "../lib/session";
import { requestCheckout } from "../lib/checkout";
import { simulateMandateAuthorization } from "../lib/mandate";
import { loadAndVerifyChain } from "../lib/audit";

const CATALOGUE = [
  { sku: "SKU-NOTE-350", name: "Notebook", description: "d", category: "Office Supplies", pricePaise: 35_000, stock: 100 },
];

beforeAll(async () => {
  await prisma.policy.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  await prisma.paymentMandate.upsert({ where: { id: "default" }, update: {}, create: { id: "default" } });
  for (const product of CATALOGUE) {
    await prisma.product.upsert({ where: { sku: product.sku }, update: product, create: product });
  }
});

beforeEach(async () => {
  await prisma.paymentAttempt.deleteMany();
  await prisma.approval.deleteMany();
  await prisma.policyDecision.deleteMany();
  await prisma.agentRequest.deleteMany();
  await prisma.sessionBinding.deleteMany();
  await simulateMandateAuthorization();
});

describe("S-09: Session Binding & Request Context Hashing", () => {
  it("generates deterministic SHA-256 session hash with stable ordering", () => {
    const hash1 = generateSessionHash({
      sessionId: "sess_test_123",
      ipAddress: "192.168.1.50",
      userAgent: "Mozilla/5.0 Chrome/120.0",
      deviceFingerprint: "fp_node_abc123",
      timestamp: 1700000000000,
    });

    const hash2 = generateSessionHash({
      timestamp: 1700000000000,
      deviceFingerprint: "fp_node_abc123",
      userAgent: "Mozilla/5.0 Chrome/120.0",
      ipAddress: "192.168.1.50",
      sessionId: "sess_test_123",
    });

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);

    // Hash mutates on any context variation
    const hash3 = generateSessionHash({
      sessionId: "sess_test_123",
      ipAddress: "192.168.1.51",
      userAgent: "Mozilla/5.0 Chrome/120.0",
      deviceFingerprint: "fp_node_abc123",
      timestamp: 1700000000000,
    });
    expect(hash1).not.toBe(hash3);
  });

  it("creates a valid 8-hour session binding and logs to Merkle audit chain", async () => {
    const now = Date.now();
    const session = await createSessionBinding({
      agentId: "agent_secure_01",
      ipAddress: "103.21.244.2",
      country: "IN",
      userAgent: "ClaudeDesktop/1.0",
      deviceFingerprint: "fp_macbook_xyz",
    });

    expect(session.sessionId).toMatch(/^sess_/);
    expect(session.agentId).toBe("agent_secure_01");
    expect(session.ipAddress).toBe("103.21.244.2");
    expect(session.country).toBe("IN");
    expect(session.expiresAt.getTime()).toBeGreaterThan(now + 7.9 * 60 * 60 * 1000);
    expect(session.expiresAt.getTime()).toBeLessThanOrEqual(now + 8.1 * 60 * 60 * 1000);

    const { events, verification } = await loadAndVerifyChain();
    expect(verification.valid).toBe(true);
    const sessionEvent = events.find((e) => e.eventType === "SESSION_CREATED");
    expect(sessionEvent).toBeTruthy();
    expect(sessionEvent?.payloadJson).toContain(session.sessionId);
  });

  it("validates legitimate session context successfully", async () => {
    const session = await createSessionBinding({
      agentId: "agent_secure_01",
      ipAddress: "103.21.244.2",
      country: "IN",
      userAgent: "ClaudeDesktop/1.0",
      deviceFingerprint: "fp_macbook_xyz",
      maxTransactionValue: 100_000,
    });

    const result = await validateSessionContext(
      {
        sessionId: session.sessionId,
        agentId: "agent_secure_01",
        ipAddress: "103.21.244.2",
        country: "IN",
        userAgent: "ClaudeDesktop/1.0",
        deviceFingerprint: "fp_macbook_xyz",
      },
      session,
      35_000,
    );

    expect(result.valid).toBe(true);
    expect(result.sessionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects expired sessions with SESSION_EXPIRED", async () => {
    const session = await createSessionBinding({
      agentId: "agent_secure_01",
      ipAddress: "103.21.244.2",
      userAgent: "ClaudeDesktop/1.0",
      deviceFingerprint: "fp_macbook_xyz",
      durationHours: -1, // Expired 1 hour ago
    });

    const result = await validateSessionContext(
      {
        sessionId: session.sessionId,
        agentId: "agent_secure_01",
        ipAddress: "103.21.244.2",
        userAgent: "ClaudeDesktop/1.0",
        deviceFingerprint: "fp_macbook_xyz",
      },
      session,
    );

    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe("SESSION_EXPIRED");
  });

  it("allows mobile IP roaming within same country, but blocks country mismatch", async () => {
    const session = await createSessionBinding({
      agentId: "agent_mobile_01",
      ipAddress: "103.21.244.2",
      country: "IN",
      userAgent: "AgentMobile/1.0",
      deviceFingerprint: "fp_iphone_123",
    });

    // 1. IP changes within same country (India) -> Allowed
    const sameCountryResult = await validateSessionContext(
      {
        sessionId: session.sessionId,
        agentId: "agent_mobile_01",
        ipAddress: "103.21.245.88",
        country: "IN",
        userAgent: "AgentMobile/1.0",
        deviceFingerprint: "fp_iphone_123",
      },
      session,
    );
    expect(sameCountryResult.valid).toBe(true);

    // 2. IP jumps to a different country (e.g., US / RU) -> Blocked
    const foreignResult = await validateSessionContext(
      {
        sessionId: session.sessionId,
        agentId: "agent_mobile_01",
        ipAddress: "198.51.100.4",
        country: "US",
        userAgent: "AgentMobile/1.0",
        deviceFingerprint: "fp_iphone_123",
      },
      session,
    );
    expect(foreignResult.valid).toBe(false);
    expect(foreignResult.reasonCode).toBe("SESSION_SUSPICIOUS_IP_COUNTRY_CHANGE");
  });

  it("detects User-Agent mutation mid-session and blocks with SESSION_USER_AGENT_MISMATCH", async () => {
    const session = await createSessionBinding({
      agentId: "agent_secure_01",
      ipAddress: "103.21.244.2",
      userAgent: "ClaudeDesktop/1.0 (macOS)",
      deviceFingerprint: "fp_macbook_xyz",
    });

    const result = await validateSessionContext(
      {
        sessionId: session.sessionId,
        agentId: "agent_secure_01",
        ipAddress: "103.21.244.2",
        userAgent: "Python-Requests/2.31 (Linux)", // Hijacker trying to reuse token via curl/python
        deviceFingerprint: "fp_macbook_xyz",
      },
      session,
    );

    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe("SESSION_USER_AGENT_MISMATCH");
  });

  it("detects device fingerprint mismatch and blocks cross-device token reuse", async () => {
    const session = await createSessionBinding({
      agentId: "agent_secure_01",
      ipAddress: "103.21.244.2",
      userAgent: "ClaudeDesktop/1.0",
      deviceFingerprint: "fp_authorized_device_1",
    });

    const result = await validateSessionContext(
      {
        sessionId: session.sessionId,
        agentId: "agent_secure_01",
        ipAddress: "103.21.244.2",
        userAgent: "ClaudeDesktop/1.0",
        deviceFingerprint: "fp_unauthorized_attacker_device",
      },
      session,
    );

    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe("SESSION_FINGERPRINT_MISMATCH");
  });

  it("blocks transactions exceeding session max transaction cap", async () => {
    const session = await createSessionBinding({
      agentId: "agent_secure_01",
      ipAddress: "103.21.244.2",
      userAgent: "ClaudeDesktop/1.0",
      deviceFingerprint: "fp_macbook_xyz",
      maxTransactionValue: 20_000, // ₹200 cap
    });

    const result = await validateSessionContext(
      {
        sessionId: session.sessionId,
        agentId: "agent_secure_01",
        ipAddress: "103.21.244.2",
        userAgent: "ClaudeDesktop/1.0",
        deviceFingerprint: "fp_macbook_xyz",
      },
      session,
      35_000, // ₹350 attempted
    );

    expect(result.valid).toBe(false);
    expect(result.reasonCode).toBe("SESSION_TRANSACTION_LIMIT_EXCEEDED");
  });

  it("integrates end-to-end checkout with valid session binding", async () => {
    const session = await createSessionBinding({
      agentId: "agent_e2e_01",
      ipAddress: "127.0.0.1",
      country: "IN",
      userAgent: "SpendBoundary-Agent/1.0",
      deviceFingerprint: "fp_e2e_device",
    });

    const checkout = await requestCheckout({
      agentId: "agent_e2e_01",
      reason: "Purchasing notebook under active session",
      items: [{ sku: "SKU-NOTE-350", quantity: 1 }],
      sessionContext: {
        sessionId: session.sessionId,
        agentId: "agent_e2e_01",
        ipAddress: "127.0.0.1",
        country: "IN",
        userAgent: "SpendBoundary-Agent/1.0",
        deviceFingerprint: "fp_e2e_device",
      },
    });

    expect(checkout.decision).toBe("ALLOW");
    expect(checkout.paymentStatus).toBe("PAID");
    expect(checkout.sessionId).toBe(session.sessionId);
    expect(checkout.sessionHash).toMatch(/^[a-f0-9]{64}$/);

    const savedRequest = await prisma.agentRequest.findUnique({ where: { id: checkout.requestId } });
    expect(savedRequest?.sessionId).toBe(session.sessionId);
    expect(savedRequest?.sessionHash).toBe(checkout.sessionHash);

    const { events, verification } = await loadAndVerifyChain();
    expect(verification.valid).toBe(true);
    expect(events.some((e) => e.eventType === "SESSION_VALIDATED")).toBe(true);
  });

  it("vetoes checkout with SESSION_USER_AGENT_MISMATCH when session hijacking is detected", async () => {
    const session = await createSessionBinding({
      agentId: "agent_hijack_target",
      ipAddress: "127.0.0.1",
      userAgent: "ClaudeDesktop/1.0",
      deviceFingerprint: "fp_target_device",
    });

    const checkout = await requestCheckout({
      agentId: "agent_hijack_target",
      reason: "Unauthorized hijack attempt",
      items: [{ sku: "SKU-NOTE-350", quantity: 1 }],
      sessionContext: {
        sessionId: session.sessionId,
        agentId: "agent_hijack_target",
        ipAddress: "127.0.0.1",
        userAgent: "EvilBot/6.6.6", // Altered User-Agent
        deviceFingerprint: "fp_target_device",
      },
    });

    expect(checkout.decision).toBe("DENY");
    expect(checkout.reasonCode).toBe("SESSION_USER_AGENT_MISMATCH");
    expect(checkout.paymentStatus).toBe("BLOCKED");
    expect(await prisma.paymentAttempt.count()).toBe(0);

    const { events, verification } = await loadAndVerifyChain();
    expect(verification.valid).toBe(true);
    expect(events.some((e) => e.eventType === "SESSION_SECURITY_ALERT")).toBe(true);
  });

  it("handles explicit session revocation cleanly", async () => {
    const session = await createSessionBinding({
      agentId: "agent_revoked_01",
      ipAddress: "127.0.0.1",
      userAgent: "SpendBoundary-Agent/1.0",
      deviceFingerprint: "fp_rev_device",
    });

    await revokeSession(session.sessionId, "User logout");
    const updated = await getSessionBinding(session.sessionId);
    expect(updated?.revokedAt).toBeTruthy();

    const checkout = await requestCheckout({
      agentId: "agent_revoked_01",
      reason: "Attempt after revocation",
      items: [{ sku: "SKU-NOTE-350", quantity: 1 }],
      sessionContext: {
        sessionId: session.sessionId,
        agentId: "agent_revoked_01",
        ipAddress: "127.0.0.1",
        userAgent: "SpendBoundary-Agent/1.0",
        deviceFingerprint: "fp_rev_device",
      },
    });

    expect(checkout.decision).toBe("DENY");
    expect(checkout.reasonCode).toBe("SESSION_EXPIRED");
    expect(checkout.reasonText).toContain("revoked");
  });
});
