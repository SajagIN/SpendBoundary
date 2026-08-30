import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./prisma";
import { canonicalize } from "./ids";
import { appendAuditEvent } from "./audit";
import type { SessionBinding } from "@prisma/client";

export const DEFAULT_SESSION_DURATION_HOURS = 8;
export const DEFAULT_MAX_TRANSACTION_PAISE = 200_000; // ₹2,000
export const DEFAULT_MAX_DAILY_SPEND_PAISE = 500_000; // ₹5,000

export type SessionContextInput = {
  sessionId: string;
  ipAddress: string;
  userAgent: string;
  deviceFingerprint: string;
  timestamp: number;
};

export type RequestContext = {
  sessionId: string;
  agentId?: string;
  ipAddress: string;
  country?: string | null;
  userAgent: string;
  deviceFingerprint: string;
  timestamp?: number;
};

export type SessionValidationReasonCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_EXPIRED"
  | "SESSION_AGENT_MISMATCH"
  | "SESSION_SUSPICIOUS_IP_COUNTRY_CHANGE"
  | "SESSION_USER_AGENT_MISMATCH"
  | "SESSION_FINGERPRINT_MISMATCH"
  | "SESSION_TRANSACTION_LIMIT_EXCEEDED";

export type SessionValidationResult = {
  valid: boolean;
  reasonCode?: SessionValidationReasonCode;
  reasonText?: string;
  session?: SessionBinding;
  sessionHash?: string;
};

export function newSessionId(): string {
  return `sess_${Date.now()}_${randomBytes(4).toString("hex")}`;
}

/**
 * Generates a deterministic SHA-256 hash over the request context.
 * Uses canonical JSON formatting to ensure stable ordering across platforms.
 */
export function generateSessionHash(context: SessionContextInput): string {
  const canonical = JSON.stringify(canonicalize(context));
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Creates a new SessionBinding record in the database with an 8-hour expiry.
 * Emits an immutable SESSION_CREATED event to the SHA-256 Merkle audit chain.
 */
export async function createSessionBinding(input: {
  sessionId?: string;
  agentId: string;
  ipAddress: string;
  country?: string | null;
  userAgent: string;
  deviceFingerprint: string;
  durationHours?: number;
  maxTransactionValue?: number;
  maxDailySpend?: number;
}): Promise<SessionBinding> {
  const sessionId = input.sessionId?.trim() || newSessionId();
  const durationHours = input.durationHours ?? DEFAULT_SESSION_DURATION_HOURS;
  const expiresAt = new Date(Date.now() + durationHours * 60 * 60 * 1000);
  const maxTransactionValue = input.maxTransactionValue ?? DEFAULT_MAX_TRANSACTION_PAISE;
  const maxDailySpend = input.maxDailySpend ?? DEFAULT_MAX_DAILY_SPEND_PAISE;

  const session = await prisma.sessionBinding.upsert({
    where: { sessionId },
    update: {
      agentId: input.agentId,
      ipAddress: input.ipAddress,
      country: input.country ?? null,
      userAgent: input.userAgent,
      deviceFingerprint: input.deviceFingerprint,
      expiresAt,
      maxTransactionValue,
      maxDailySpend,
      revokedAt: null,
    },
    create: {
      sessionId,
      agentId: input.agentId,
      ipAddress: input.ipAddress,
      country: input.country ?? null,
      userAgent: input.userAgent,
      deviceFingerprint: input.deviceFingerprint,
      expiresAt,
      maxTransactionValue,
      maxDailySpend,
    },
  });

  const sessionHash = generateSessionHash({
    sessionId,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    deviceFingerprint: input.deviceFingerprint,
    timestamp: session.createdAt.getTime(),
  });

  await appendAuditEvent("SESSION_CREATED", {
    sessionId,
    agentId: input.agentId,
    ipAddress: input.ipAddress,
    country: input.country ?? null,
    userAgent: input.userAgent,
    deviceFingerprint: input.deviceFingerprint,
    expiresAt: expiresAt.toISOString(),
    maxTransactionValue,
    maxDailySpend,
    sessionHash,
  });

  return session;
}

export async function getSessionBinding(sessionId: string): Promise<SessionBinding | null> {
  return prisma.sessionBinding.findUnique({ where: { sessionId } });
}

/**
 * Validates an incoming request context against an existing SessionBinding.
 * Enforces:
 *  1. Non-revocation & 8-hour expiry window
 *  2. Agent ID identity match
 *  3. IP and Geolocation consistency (allows local subnet changes; blocks cross-country drift)
 *  4. Exact User-Agent match
 *  5. Device Fingerprint consistency
 *  6. Single-transaction session value limits
 */
export async function validateSessionContext(
  requestContext: RequestContext,
  existingSession: SessionBinding,
  transactionAmountPaise?: number,
): Promise<SessionValidationResult> {
  // 1. Expiration & revocation check
  if (existingSession.revokedAt) {
    return {
      valid: false,
      reasonCode: "SESSION_EXPIRED",
      reasonText: "Session has been explicitly revoked.",
      session: existingSession,
    };
  }

  if (existingSession.expiresAt.getTime() < Date.now()) {
    return {
      valid: false,
      reasonCode: "SESSION_EXPIRED",
      reasonText: "Session has expired (8-hour lifetime window exceeded).",
      session: existingSession,
    };
  }

  // 2. Agent ID check
  if (requestContext.agentId && existingSession.agentId !== requestContext.agentId) {
    return {
      valid: false,
      reasonCode: "SESSION_AGENT_MISMATCH",
      reasonText: `Agent ID '${requestContext.agentId}' does not match bound session agent '${existingSession.agentId}'.`,
      session: existingSession,
    };
  }

  // 3. IP and Geolocation validation
  // Allow slight IP variance for mobile/ISP roaming, but block different country
  const ipChanged = requestContext.ipAddress !== existingSession.ipAddress;
  if (
    ipChanged &&
    requestContext.country &&
    existingSession.country &&
    requestContext.country.toUpperCase() !== existingSession.country.toUpperCase()
  ) {
    return {
      valid: false,
      reasonCode: "SESSION_SUSPICIOUS_IP_COUNTRY_CHANGE",
      reasonText: `Suspicious geolocation jump: IP changed from ${existingSession.ipAddress} (${existingSession.country}) to ${requestContext.ipAddress} (${requestContext.country}).`,
      session: existingSession,
    };
  }

  // 4. User-Agent match
  if (requestContext.userAgent !== existingSession.userAgent) {
    return {
      valid: false,
      reasonCode: "SESSION_USER_AGENT_MISMATCH",
      reasonText: `User-Agent mutated mid-session (bound: '${existingSession.userAgent}', received: '${requestContext.userAgent}'). Session hijacking suspected.`,
      session: existingSession,
    };
  }

  // 5. Device Fingerprint consistency
  if (
    requestContext.deviceFingerprint &&
    existingSession.deviceFingerprint &&
    requestContext.deviceFingerprint !== existingSession.deviceFingerprint
  ) {
    return {
      valid: false,
      reasonCode: "SESSION_FINGERPRINT_MISMATCH",
      reasonText: "Device fingerprint mismatch. Cross-device token reuse blocked.",
      session: existingSession,
    };
  }

  // 6. Session per-transaction cap
  if (
    typeof transactionAmountPaise === "number" &&
    transactionAmountPaise > existingSession.maxTransactionValue
  ) {
    return {
      valid: false,
      reasonCode: "SESSION_TRANSACTION_LIMIT_EXCEEDED",
      reasonText: `Transaction value (${transactionAmountPaise} paise) exceeds session max limit (${existingSession.maxTransactionValue} paise).`,
      session: existingSession,
    };
  }

  const timestamp = requestContext.timestamp ?? Date.now();
  const sessionHash = generateSessionHash({
    sessionId: existingSession.sessionId,
    ipAddress: requestContext.ipAddress,
    userAgent: requestContext.userAgent,
    deviceFingerprint: requestContext.deviceFingerprint,
    timestamp,
  });

  return {
    valid: true,
    session: existingSession,
    sessionHash,
  };
}

/**
 * Revokes an active session immediately.
 */
export async function revokeSession(sessionId: string, reason = "USER_REVOKED") {
  const session = await prisma.sessionBinding.update({
    where: { sessionId },
    data: { revokedAt: new Date() },
  });

  await appendAuditEvent("SESSION_REVOKED", {
    sessionId,
    agentId: session.agentId,
    reason,
    revokedAt: session.revokedAt?.toISOString(),
  });

  return session;
}
