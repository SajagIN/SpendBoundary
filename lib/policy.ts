import { assertPaise } from "./money";

/**
 * Deterministic policy rule engine (Rules R-02, R-04).
 *
 * This module is intentionally pure: no database, no clock, no network. Every
 * input it needs is passed in, so the same inputs always produce the same
 * verdict and the whole engine is unit-testable without a running gateway.
 */

export type Decision = "ALLOW" | "REVIEW" | "DENY";

export type ReasonCode =
  | "WITHIN_AUTONOMOUS_LIMIT"
  | "APPROVAL_THRESHOLD_TRIGGERED"
  | "ORDER_CAP_EXCEEDED"
  | "DAILY_CAP_EXCEEDED"
  | "CATEGORY_NOT_ALLOWED"
  | "VELOCITY_LIMIT_EXCEEDED"
  | "CIRCUIT_BREAKER_ACTIVE"
  | "EMPTY_CART"
  | "UNKNOWN_SKU"
  | "OUT_OF_STOCK";

export type PolicyConfig = {
  maxOrderPaise: number;
  dailyCapPaise: number;
  approvalThresholdPaise: number;
  allowedCategories: string[];
  velocityMaxRequests: number;
  velocityWindowSec: number;
  velocityLockoutSec: number;
};

export type VerifiedItem = {
  sku: string;
  name: string;
  category: string;
  unitPricePaise: number;
  quantity: number;
  lineTotalPaise: number;
};

export type EvaluationContext = {
  items: VerifiedItem[];
  subtotalPaise: number;
  /** Rolling 24h spend already captured, excluding this request. */
  dailySpentPaise: number;
  /** Epoch ms of prior evaluated requests by this agent, newest first. */
  recentRequestEpochs: number[];
  /** Epoch ms of "now" for this evaluation. */
  nowEpoch: number;
  /** Epoch ms until which a previously tripped circuit breaker still holds. */
  circuitBreakerUntilEpoch?: number;
  /** SKUs the agent asked for that do not exist in the catalogue. */
  unknownSkus: string[];
  /** SKUs whose requested quantity exceeds available stock. */
  outOfStockSkus: string[];
};

export type RuleResult = {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
};

export type PolicyEvaluation = {
  decision: Decision;
  reasonCode: ReasonCode;
  reasonText: string;
  amountPaise: number;
  rules: RuleResult[];
  /** Set when the velocity circuit breaker fires; epoch ms the lock expires. */
  lockedUntilEpoch?: number;
};

export const DEFAULT_POLICY: PolicyConfig = {
  maxOrderPaise: 200_000,
  dailyCapPaise: 500_000,
  approvalThresholdPaise: 100_000,
  allowedCategories: ["Office Supplies", "Electronics", "Home Office", "Furniture"],
  velocityMaxRequests: 3,
  velocityWindowSec: 60,
  velocityLockoutSec: 900,
};

export function parseCategories(csv: string): string[] {
  return csv
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Evaluates a server-verified cart against the merchant policy.
 * Hard vetoes are checked first, so a DENY always wins over a REVIEW.
 */
export function evaluatePolicy(policy: PolicyConfig, context: EvaluationContext): PolicyEvaluation {
  const amountPaise = assertPaise(context.subtotalPaise, "subtotalPaise");
  const rules: RuleResult[] = [];

  const deny = (
    reasonCode: ReasonCode,
    reasonText: string,
    lockedUntilEpoch?: number,
  ): PolicyEvaluation => ({
    decision: "DENY",
    reasonCode,
    reasonText,
    amountPaise,
    rules,
    lockedUntilEpoch,
  });

  // Rule 0 - cart integrity. The server, never the LLM, owns the cart.
  rules.push({
    id: "R-00",
    label: "Cart Integrity & Server Re-Pricing",
    passed:
      context.items.length > 0 &&
      context.unknownSkus.length === 0 &&
      context.outOfStockSkus.length === 0,
    detail:
      context.unknownSkus.length > 0
        ? `Unknown SKUs rejected: ${context.unknownSkus.join(", ")}`
        : context.outOfStockSkus.length > 0
          ? `Insufficient stock for: ${context.outOfStockSkus.join(", ")}`
          : context.items.length === 0
            ? "Cart contained zero resolvable line items"
            : `${context.items.length} line item(s) re-priced from database source of truth`,
  });

  if (context.unknownSkus.length > 0) {
    return deny(
      "UNKNOWN_SKU",
      `Cart references SKUs that do not exist: ${context.unknownSkus.join(", ")}.`,
    );
  }
  if (context.items.length === 0) {
    return deny("EMPTY_CART", "Cart contained no valid line items after server-side re-pricing.");
  }
  if (context.outOfStockSkus.length > 0) {
    return deny("OUT_OF_STOCK", `Insufficient stock for: ${context.outOfStockSkus.join(", ")}.`);
  }

  // Rule 4a - a circuit breaker tripped by an earlier burst is still holding.
  if (context.circuitBreakerUntilEpoch && context.circuitBreakerUntilEpoch > context.nowEpoch) {
    const secondsLeft = Math.ceil((context.circuitBreakerUntilEpoch - context.nowEpoch) / 1000);
    rules.push({
      id: "R-04",
      label: `Velocity Circuit Breaker (${policy.velocityLockoutSec}s lockout)`,
      passed: false,
      detail: `Agent is locked out for another ${secondsLeft}s after an earlier velocity burst`,
    });
    return deny(
      "CIRCUIT_BREAKER_ACTIVE",
      `Agent is inside a velocity circuit-breaker lockout for another ${secondsLeft}s. All transactions are denied until it expires.`,
      context.circuitBreakerUntilEpoch,
    );
  }

  // Rule 4b - velocity burst limiter and 15 minute circuit breaker.
  const windowMs = policy.velocityWindowSec * 1000;
  const inWindow = context.recentRequestEpochs.filter(
    (epoch) => context.nowEpoch - epoch < windowMs,
  );
  const velocityBreached = inWindow.length >= policy.velocityMaxRequests;
  rules.push({
    id: "R-04",
    label: `Velocity Burst Limiter (max ${policy.velocityMaxRequests} / ${policy.velocityWindowSec}s)`,
    passed: !velocityBreached,
    detail: `${inWindow.length} prior request(s) inside the ${policy.velocityWindowSec}s window`,
  });
  if (velocityBreached) {
    const lockedUntilEpoch = context.nowEpoch + policy.velocityLockoutSec * 1000;
    return deny(
      "VELOCITY_LIMIT_EXCEEDED",
      `Velocity burst limit hit: ${inWindow.length + 1} requests in ${policy.velocityWindowSec}s (max ${policy.velocityMaxRequests}). Agent locked for ${Math.round(policy.velocityLockoutSec / 60)} minutes.`,
      lockedUntilEpoch,
    );
  }

  // Rule 3 - category whitelist.
  const blockedCategories = [
    ...new Set(
      context.items
        .filter((item) => !policy.allowedCategories.includes(item.category))
        .map((item) => item.category),
    ),
  ];
  rules.push({
    id: "R-03",
    label: "Category Whitelist Enforcement",
    passed: blockedCategories.length === 0,
    detail:
      blockedCategories.length > 0
        ? `Blocked categories: ${blockedCategories.join(", ")}`
        : `All categories whitelisted (${policy.allowedCategories.join(", ")})`,
  });
  if (blockedCategories.length > 0) {
    return deny(
      "CATEGORY_NOT_ALLOWED",
      `Cart contains a non-whitelisted category: ${blockedCategories.join(", ")}.`,
    );
  }

  // Rule 1 - single-order hard cap.
  if (amountPaise > policy.maxOrderPaise) {
    rules.push({
      id: "R-01",
      label: "Single-Order Cap",
      passed: false,
      detail: `${amountPaise} paise requested against a ${policy.maxOrderPaise} paise cap`,
    });
    return deny(
      "ORDER_CAP_EXCEEDED",
      `Order total exceeds the single-order cap (${amountPaise} paise > ${policy.maxOrderPaise} paise).`,
    );
  }
  rules.push({
    id: "R-01",
    label: "Single-Order Cap",
    passed: true,
    detail: `${amountPaise} paise requested against a ${policy.maxOrderPaise} paise cap`,
  });

  // Rule 2 - rolling 24h spend cap.
  const projectedSpend = context.dailySpentPaise + amountPaise;
  const dailyOk = projectedSpend <= policy.dailyCapPaise;
  rules.push({
    id: "R-02",
    label: "24-Hour Rolling Spend Cap",
    passed: dailyOk,
    detail: `${context.dailySpentPaise} paise already spent; this request would reach ${projectedSpend} of ${policy.dailyCapPaise} paise`,
  });
  if (!dailyOk) {
    return deny(
      "DAILY_CAP_EXCEEDED",
      `24-hour rolling spend cap reached (${projectedSpend} paise > ${policy.dailyCapPaise} paise).`,
    );
  }

  // Rule 5 - dynamic approval threshold splits Zone 1 from Zone 2.
  const autonomous = amountPaise < policy.approvalThresholdPaise;
  rules.push({
    id: "R-05",
    label: "Dynamic Approval Threshold",
    passed: autonomous,
    detail: `${amountPaise} paise ${autonomous ? "is below" : "meets or exceeds"} the ${policy.approvalThresholdPaise} paise human-review threshold`,
  });

  if (autonomous) {
    return {
      decision: "ALLOW",
      reasonCode: "WITHIN_AUTONOMOUS_LIMIT",
      reasonText: `Within the autonomous zone (${amountPaise} paise < ${policy.approvalThresholdPaise} paise). Debiting the tokenized mandate with zero OTP.`,
      amountPaise,
      rules,
    };
  }

  return {
    decision: "REVIEW",
    reasonCode: "APPROVAL_THRESHOLD_TRIGGERED",
    reasonText: `Above the autonomous threshold (${amountPaise} paise >= ${policy.approvalThresholdPaise} paise). Autonomous debit halted; a hosted payment link requires human authorization.`,
    amountPaise,
    rules,
  };
}
