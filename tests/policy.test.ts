import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  evaluatePolicy,
  parseCategories,
  type EvaluationContext,
  type VerifiedItem,
} from "../lib/policy";

const NOW = 1_800_000_000_000;

function item(overrides: Partial<VerifiedItem> = {}): VerifiedItem {
  const unitPricePaise = overrides.unitPricePaise ?? 35_000;
  const quantity = overrides.quantity ?? 1;
  return {
    sku: overrides.sku ?? "SKU-NOTE-350",
    name: overrides.name ?? "A5 Dotted Notebook",
    category: overrides.category ?? "Office Supplies",
    unitPricePaise,
    quantity,
    lineTotalPaise: overrides.lineTotalPaise ?? unitPricePaise * quantity,
  };
}

function context(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  const items = overrides.items ?? [item()];
  return {
    items,
    subtotalPaise:
      overrides.subtotalPaise ?? items.reduce((total, entry) => total + entry.lineTotalPaise, 0),
    dailySpentPaise: overrides.dailySpentPaise ?? 0,
    recentRequestEpochs: overrides.recentRequestEpochs ?? [],
    nowEpoch: overrides.nowEpoch ?? NOW,
    circuitBreakerUntilEpoch: overrides.circuitBreakerUntilEpoch,
    unknownSkus: overrides.unknownSkus ?? [],
    outOfStockSkus: overrides.outOfStockSkus ?? [],
  };
}

describe("Zone 1 — autonomous ALLOW", () => {
  it("allows a ₹350 notebook below the ₹1,000 threshold (AC-01)", () => {
    const result = evaluatePolicy(DEFAULT_POLICY, context());
    expect(result.decision).toBe("ALLOW");
    expect(result.reasonCode).toBe("WITHIN_AUTONOMOUS_LIMIT");
    expect(result.amountPaise).toBe(35_000);
  });

  it("allows a multi-line cart that still totals under the threshold", () => {
    const result = evaluatePolicy(
      DEFAULT_POLICY,
      context({ items: [item({ unitPricePaise: 50_000 }), item({ sku: "SKU-PEN-120", unitPricePaise: 12_000 })] }),
    );
    expect(result.decision).toBe("ALLOW");
    expect(result.amountPaise).toBe(62_000);
  });
});

describe("Zone 2 — human REVIEW", () => {
  it("halts a ₹1,500 lamp for human authorization (AC-02)", () => {
    const result = evaluatePolicy(
      DEFAULT_POLICY,
      context({ items: [item({ sku: "SKU-LAMP-1500", category: "Home Office", unitPricePaise: 150_000 })] }),
    );
    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCode).toBe("APPROVAL_THRESHOLD_TRIGGERED");
  });

  it("treats exactly the threshold as REVIEW, not ALLOW", () => {
    const result = evaluatePolicy(
      DEFAULT_POLICY,
      context({ items: [item({ unitPricePaise: 100_000 })] }),
    );
    expect(result.decision).toBe("REVIEW");
  });

  it("treats one paise under the threshold as ALLOW", () => {
    const result = evaluatePolicy(
      DEFAULT_POLICY,
      context({ items: [item({ unitPricePaise: 99_999 })] }),
    );
    expect(result.decision).toBe("ALLOW");
  });
});

describe("Zone 3 — hard DENY", () => {
  it("denies a ₹8,000 chair over the single-order cap", () => {
    const result = evaluatePolicy(
      DEFAULT_POLICY,
      context({ items: [item({ sku: "SKU-CHAIR-8000", category: "Furniture", unitPricePaise: 800_000 })] }),
    );
    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe("ORDER_CAP_EXCEEDED");
  });

  it("denies a non-whitelisted category before the amount is even considered (AC-03)", () => {
    const result = evaluatePolicy(
      DEFAULT_POLICY,
      context({ items: [item({ sku: "SKU-MINER-5000", category: "Crypto", unitPricePaise: 500_000 })] }),
    );
    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe("CATEGORY_NOT_ALLOWED");
  });

  it("denies once the rolling 24h cap would be breached", () => {
    const result = evaluatePolicy(
      DEFAULT_POLICY,
      context({ dailySpentPaise: 480_000, items: [item({ unitPricePaise: 50_000 })] }),
    );
    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe("DAILY_CAP_EXCEEDED");
  });

  it("allows a request that lands exactly on the daily cap", () => {
    const result = evaluatePolicy(
      DEFAULT_POLICY,
      context({ dailySpentPaise: 450_000, items: [item({ unitPricePaise: 50_000 })] }),
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("denies an unknown SKU", () => {
    const result = evaluatePolicy(
      DEFAULT_POLICY,
      context({ items: [], subtotalPaise: 0, unknownSkus: ["SKU-DOES-NOT-EXIST"] }),
    );
    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe("UNKNOWN_SKU");
  });

  it("denies an empty cart", () => {
    const result = evaluatePolicy(DEFAULT_POLICY, context({ items: [], subtotalPaise: 0 }));
    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe("EMPTY_CART");
  });

  it("denies when stock is insufficient", () => {
    const result = evaluatePolicy(
      DEFAULT_POLICY,
      context({ outOfStockSkus: ["SKU-NOTE-350"] }),
    );
    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe("OUT_OF_STOCK");
  });
});

describe("R-04 velocity burst limiter", () => {
  it("permits the first three requests inside the window", () => {
    const result = evaluatePolicy(
      DEFAULT_POLICY,
      context({ recentRequestEpochs: [NOW - 5_000, NOW - 10_000] }),
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("denies the fourth request inside the window (AC-04)", () => {
    const result = evaluatePolicy(
      DEFAULT_POLICY,
      context({ recentRequestEpochs: [NOW - 5_000, NOW - 10_000, NOW - 20_000] }),
    );
    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe("VELOCITY_LIMIT_EXCEEDED");
    expect(result.lockedUntilEpoch).toBe(NOW + 900_000);
  });

  it("ignores requests that fell outside the window", () => {
    const result = evaluatePolicy(
      DEFAULT_POLICY,
      context({ recentRequestEpochs: [NOW - 61_000, NOW - 70_000, NOW - 80_000] }),
    );
    expect(result.decision).toBe("ALLOW");
  });

  it("keeps denying while the circuit breaker lockout is still live", () => {
    const result = evaluatePolicy(
      DEFAULT_POLICY,
      context({ circuitBreakerUntilEpoch: NOW + 60_000 }),
    );
    expect(result.decision).toBe("DENY");
    expect(result.reasonCode).toBe("CIRCUIT_BREAKER_ACTIVE");
  });

  it("resumes normal evaluation once the lockout has expired", () => {
    const result = evaluatePolicy(
      DEFAULT_POLICY,
      context({ circuitBreakerUntilEpoch: NOW - 1 }),
    );
    expect(result.decision).toBe("ALLOW");
  });
});

describe("rule trace and configuration", () => {
  it("returns a rule-by-rule trace on every verdict", () => {
    const result = evaluatePolicy(DEFAULT_POLICY, context());
    const ids = result.rules.map((rule) => rule.id);
    expect(ids).toContain("R-00");
    expect(ids).toContain("R-04");
    expect(ids).toContain("R-05");
    expect(result.rules.every((rule) => typeof rule.detail === "string")).toBe(true);
  });

  it("honours a tightened threshold from the policy editor", () => {
    const strict = { ...DEFAULT_POLICY, approvalThresholdPaise: 20_000 };
    const result = evaluatePolicy(strict, context());
    expect(result.decision).toBe("REVIEW");
  });

  it("parses the stored category whitelist", () => {
    expect(parseCategories("Office Supplies, Electronics ,, Furniture")).toEqual([
      "Office Supplies",
      "Electronics",
      "Furniture",
    ]);
  });
});
