import { describe, expect, it } from "vitest";
import { GENESIS_HASH, computeEventHash, serializePayload, verifyChain, type ChainRecord } from "../lib/audit";
import { canonicalize, idempotencyKey } from "../lib/ids";

function buildChain(payloads: string[]): ChainRecord[] {
  const events: ChainRecord[] = [];
  let previousHash = GENESIS_HASH;
  payloads.forEach((payload, index) => {
    const createdAt = new Date(1_800_000_000_000 + index * 1_000).toISOString();
    const eventType = "POLICY_DECISION_EVALUATED";
    const payloadJson = serializePayload({ note: payload });
    const eventHash = computeEventHash({ previousHash, payloadJson, eventType, createdAt });
    events.push({ index, eventType, payloadJson, previousHash, eventHash, createdAt });
    previousHash = eventHash;
  });
  return events;
}

describe("R-06 SHA-256 Merkle audit chain", () => {
  it("starts from a 64 zero genesis hash", () => {
    expect(GENESIS_HASH).toHaveLength(64);
    expect(GENESIS_HASH).toMatch(/^0{64}$/);
  });

  it("produces a 64 hex character hash", () => {
    const hash = computeEventHash({
      previousHash: GENESIS_HASH,
      payloadJson: "{}",
      eventType: "AGENT_REQUEST",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies an intact chain", () => {
    const chain = buildChain(["one", "two", "three"]);
    const result = verifyChain(chain);
    expect(result.valid).toBe(true);
    expect(result.length).toBe(3);
    expect(result.brokenIndex).toBeNull();
  });

  it("detects a payload edited after sealing (AC-06)", () => {
    const chain = buildChain(["one", "two", "three"]);
    chain[1].payloadJson = serializePayload({ note: "silently rewritten" });
    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
    expect(result.brokenIndex).toBe(1);
    expect(result.reason).toMatch(/Hash mismatch/);
  });

  it("detects a rewritten link between two blocks", () => {
    const chain = buildChain(["one", "two", "three"]);
    chain[2].previousHash = GENESIS_HASH;
    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
    expect(result.brokenIndex).toBe(2);
    expect(result.reason).toMatch(/Broken link/);
  });

  it("detects a deleted block", () => {
    const chain = buildChain(["one", "two", "three"]);
    const result = verifyChain([chain[0], chain[2]]);
    expect(result.valid).toBe(false);
    expect(result.brokenIndex).toBe(2);
  });

  it("hashes are order independent for object keys but not for values", () => {
    expect(serializePayload({ b: 1, a: 2 })).toBe(serializePayload({ a: 2, b: 1 }));
    expect(serializePayload({ a: 1 })).not.toBe(serializePayload({ a: 2 }));
  });
});

describe("F4 deterministic idempotency keys", () => {
  const cart = [{ sku: "SKU-NOTE-350", quantity: 1 }];

  it("returns the same key for the same cart inside the same minute bucket", () => {
    const first = idempotencyKey({ agentId: "a1", cartSnapshot: cart, epochTimestamp: 1_800_000_000_000 });
    const second = idempotencyKey({ agentId: "a1", cartSnapshot: cart, epochTimestamp: 1_800_000_030_000 });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the cart changes", () => {
    const first = idempotencyKey({ agentId: "a1", cartSnapshot: cart, epochTimestamp: 1_800_000_000_000 });
    const second = idempotencyKey({
      agentId: "a1",
      cartSnapshot: [{ sku: "SKU-NOTE-350", quantity: 2 }],
      epochTimestamp: 1_800_000_000_000,
    });
    expect(first).not.toBe(second);
  });

  it("changes when the agent changes", () => {
    const first = idempotencyKey({ agentId: "a1", cartSnapshot: cart, epochTimestamp: 1_800_000_000_000 });
    const second = idempotencyKey({ agentId: "a2", cartSnapshot: cart, epochTimestamp: 1_800_000_000_000 });
    expect(first).not.toBe(second);
  });

  it("canonicalizes nested key order", () => {
    expect(canonicalize({ z: { b: 1, a: 2 } })).toEqual({ z: { a: 2, b: 1 } });
  });
});
