import { createHash } from "node:crypto";
import { prisma } from "./prisma";
import { canonicalize } from "./ids";

/**
 * Rule R-06 — append-only SHA-256 Merkle audit chain.
 *
 *   EventHash = SHA-256(PreviousHash + PayloadJson + EventType + CreatedAt)
 *
 * The genesis previous-hash is 64 zeros. `createdAt` is stored as the exact
 * ISO string that was hashed, so verification is byte-exact and any edit to a
 * historical row breaks every subsequent link.
 */
export const GENESIS_HASH = "0".repeat(64);

export type AuditEventType =
  | "AGENT_REQUEST"
  | "POLICY_DECISION_EVALUATED"
  | "APPROVAL_SUBMITTED"
  | "PAYMENT_ATTEMPT_RECORDED"
  | "PAYMENT_CAPTURED"
  | "PAYMENT_MANDATE_ACTIVATED"
  | "MANDATE_AUTO_DEBIT_CAPTURED"
  | "RETRY_DEDUPLICATED"
  | "POLICY_UPDATED"
  | "SPEND_RESET"
  | "TAMPER_DETECTED";

export function computeEventHash(input: {
  previousHash: string;
  payloadJson: string;
  eventType: string;
  createdAt: string;
}): string {
  return createHash("sha256")
    .update(input.previousHash + input.payloadJson + input.eventType + input.createdAt)
    .digest("hex");
}

export function serializePayload(payload: unknown): string {
  return JSON.stringify(canonicalize(payload) ?? {});
}

/** Appends one immutable event to the tail of the chain. */
export async function appendAuditEvent(
  eventType: AuditEventType,
  payload: unknown,
  requestId?: string,
) {
  const tail = await prisma.auditEvent.findFirst({ orderBy: { index: "desc" } });
  const previousHash = tail?.eventHash ?? GENESIS_HASH;
  const index = (tail?.index ?? -1) + 1;
  const payloadJson = serializePayload(payload);
  const createdAt = new Date().toISOString();
  const eventHash = computeEventHash({ previousHash, payloadJson, eventType, createdAt });

  return prisma.auditEvent.create({
    data: { index, eventType, requestId, payloadJson, previousHash, eventHash, createdAt },
  });
}

export type ChainRecord = {
  index: number;
  eventType: string;
  payloadJson: string;
  previousHash: string;
  eventHash: string;
  createdAt: string;
};

export type ChainVerification = {
  valid: boolean;
  length: number;
  brokenIndex: number | null;
  reason: string | null;
  headHash: string;
};

/** Pure verifier — recomputes every hash and every previous-hash link. */
export function verifyChain(events: ChainRecord[]): ChainVerification {
  const ordered = [...events].sort((a, b) => a.index - b.index);
  let previousHash = GENESIS_HASH;

  for (const event of ordered) {
    if (event.previousHash !== previousHash) {
      return {
        valid: false,
        length: ordered.length,
        brokenIndex: event.index,
        reason: `Broken link at block #${event.index}: stored previousHash does not match hash of block #${event.index - 1}.`,
        headHash: previousHash,
      };
    }
    const expected = computeEventHash({
      previousHash: event.previousHash,
      payloadJson: event.payloadJson,
      eventType: event.eventType,
      createdAt: event.createdAt,
    });
    if (expected !== event.eventHash) {
      return {
        valid: false,
        length: ordered.length,
        brokenIndex: event.index,
        reason: `Hash mismatch at block #${event.index}: payload was modified after it was sealed.`,
        headHash: previousHash,
      };
    }
    previousHash = event.eventHash;
  }

  return {
    valid: true,
    length: ordered.length,
    brokenIndex: null,
    reason: null,
    headHash: previousHash,
  };
}

/** Reads the whole ledger and verifies it (dashboard calls this on every load). */
export async function loadAndVerifyChain() {
  const events = await prisma.auditEvent.findMany({ orderBy: { index: "asc" } });
  return { events, verification: verifyChain(events) };
}
