import { createHash, randomBytes } from "node:crypto";

/**
 * Incident E01 — client-supplied request IDs collided on retry and blew up
 * with Prisma P2002. IDs are now generated server-side with cryptographic
 * randomness; the deterministic part of a retry lives in the idempotency key.
 */
export function newRequestId(): string {
  return `req_${Date.now()}_${randomBytes(4).toString("hex")}`;
}

export function newAgentId(): string {
  return `agent_${randomBytes(4).toString("hex")}`;
}

export type IdempotencyInput = {
  agentId: string;
  cartSnapshot: unknown;
  epochTimestamp: number;
};

/**
 * F4 — deterministic SHA-256 idempotency key over agentId + cart + epoch
 * bucket. The epoch is floored to a 60 second bucket so that a hallucinating
 * agent re-submitting the identical cart within the same minute produces the
 * identical key and is quarantined instead of double charged.
 */
export function idempotencyKey({ agentId, cartSnapshot, epochTimestamp }: IdempotencyInput): string {
  const bucket = Math.floor(epochTimestamp / 60_000);
  const canonical = JSON.stringify({ agentId, cart: canonicalize(cartSnapshot), bucket });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Stable key ordering so that JSON key order never changes the hash. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, canonicalize(inner)]),
    );
  }
  return value;
}
