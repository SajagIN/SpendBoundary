import { prisma } from "./prisma";
import { appendAuditEvent } from "./audit";
import { idempotencyKey, newRequestId } from "./ids";
import { lineTotalPaise, sumPaise, formatPaise } from "./money";
import {
  evaluatePolicy,
  parseCategories,
  type PolicyConfig,
  type PolicyEvaluation,
  type VerifiedItem,
} from "./policy";
import {
  GatewayTimeoutError,
  RecurringUnsupportedError,
  razorpayGateway,
  gatewayMode,
} from "./razorpay";
import { getOrCreateMandateSetupLink, getMandateRecord, toMandateView } from "./mandate";
import {
  type RequestContext,
  getSessionBinding,
  validateSessionContext,
} from "./session";

export const DEFAULT_AGENT_ID = "agent_demo_console";

export type CheckoutItemInput = {
  sku: string;
  quantity: number;
  /** Whatever price the LLM claimed. Recorded, never trusted, never used. */
  claimedPricePaise?: number;
};

export type CheckoutInput = {
  agentId?: string;
  reason: string;
  items: CheckoutItemInput[];
  /** Test hook for AC-05: forces an ambiguous gateway status on debit. */
  simulateTimeout?: boolean;
  /** S-09: Authenticated session context */
  sessionContext?: RequestContext;
  sessionId?: string;
};

export type PaymentStatus =
  | "PAID"
  | "AWAITING_HUMAN_APPROVAL"
  | "AWAITING_PAYMENT"
  | "BLOCKED"
  | "DEBIT_IN_PROGRESS"
  | "MANDATE_REQUIRED"
  | "QUARANTINED_PENDING_RECONCILIATION"
  | "RETRY_DEDUPLICATED";

export type CheckoutResult = {
  requestId: string;
  agentId: string;
  sessionId?: string;
  sessionHash?: string;
  decision: "ALLOW" | "REVIEW" | "DENY";
  reasonCode: string;
  reasonText: string;
  paymentStatus: PaymentStatus;
  amountPaise: number;
  amountFormatted: string;
  items: VerifiedItem[];
  rejectedItems: { sku: string; problem: string }[];
  rules: PolicyEvaluation["rules"];
  paymentLinkUrl?: string;
  orderId?: string;
  paymentId?: string;
  mandate: Awaited<ReturnType<typeof toMandateView>>;
  telemetry: {
    requestedAt: string;
    evaluatedAt: string;
    debitedAt?: string;
    latencyMs: number;
    epochTimestamp: number;
  };
  idempotencyKey: string;
  gatewayMode: string;
  agentGuidance: string;
};

export async function getPolicyConfig(): Promise<PolicyConfig & { id: string }> {
  const record =
    (await prisma.policy.findUnique({ where: { id: "default" } })) ??
    (await prisma.policy.create({ data: { id: "default" } }));
  return {
    id: record.id,
    maxOrderPaise: record.maxOrderPaise,
    dailyCapPaise: record.dailyCapPaise,
    approvalThresholdPaise: record.approvalThresholdPaise,
    allowedCategories: parseCategories(record.allowedCategories),
    velocityMaxRequests: record.velocityMaxRequests,
    velocityWindowSec: record.velocityWindowSec,
    velocityLockoutSec: record.velocityLockoutSec,
  };
}

/** Rolling 24h captured spend — the only spend that counts against R-02. */
export async function getDailySpentPaise(): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const attempts = await prisma.paymentAttempt.findMany({
    where: { status: "PAID", createdAt: { gte: since } },
    select: { amountPaise: true },
  });
  return sumPaise(attempts.map((attempt) => attempt.amountPaise));
}

/**
 * Re-prices the agent cart from the database. Anything the LLM asserted about
 * price or total is discarded here (Architecture §5, LLM untrusted boundary).
 */
async function repriceCart(items: CheckoutItemInput[]) {
  const verified: VerifiedItem[] = [];
  const unknownSkus: string[] = [];
  const outOfStockSkus: string[] = [];
  const rejectedItems: { sku: string; problem: string }[] = [];
  const priceMismatches: { sku: string; claimedPaise: number; actualPaise: number }[] = [];

  for (const item of items) {
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      rejectedItems.push({ sku: item.sku, problem: "Quantity must be a positive integer" });
      continue;
    }
    const product = await prisma.product.findUnique({ where: { sku: item.sku } });
    if (!product) {
      unknownSkus.push(item.sku);
      rejectedItems.push({ sku: item.sku, problem: "SKU not found in merchant catalogue" });
      continue;
    }
    if (product.stock < quantity) {
      outOfStockSkus.push(item.sku);
      rejectedItems.push({
        sku: item.sku,
        problem: `Only ${product.stock} in stock, ${quantity} requested`,
      });
      continue;
    }
    if (
      typeof item.claimedPricePaise === "number" &&
      item.claimedPricePaise !== product.pricePaise
    ) {
      priceMismatches.push({
        sku: item.sku,
        claimedPaise: item.claimedPricePaise,
        actualPaise: product.pricePaise,
      });
    }
    verified.push({
      sku: product.sku,
      name: product.name,
      category: product.category,
      unitPricePaise: product.pricePaise,
      quantity,
      lineTotalPaise: lineTotalPaise(product.pricePaise, quantity),
    });
  }

  return {
    verified,
    unknownSkus,
    outOfStockSkus,
    rejectedItems,
    priceMismatches,
    subtotalPaise: sumPaise(verified.map((item) => item.lineTotalPaise)),
  };
}

/** Most recent velocity lockout still in force for this agent, if any. */
async function activeCircuitBreakerUntil(agentId: string, lockoutSec: number) {
  const lastBurst = await prisma.policyDecision.findFirst({
    where: {
      reasonCode: "VELOCITY_LIMIT_EXCEEDED",
      request: { agentId },
    },
    orderBy: { evaluatedAt: "desc" },
  });
  if (!lastBurst) return undefined;
  const until = lastBurst.evaluatedAt.getTime() + lockoutSec * 1000;
  return until > Date.now() ? until : undefined;
}

function guidanceFor(status: PaymentStatus, result: Partial<CheckoutResult>): string {
  switch (status) {
    case "PAID":
      return `Payment captured with zero OTP. Tell the user the order is confirmed for ${result.amountFormatted}. Do NOT submit this cart again.`;
    case "AWAITING_PAYMENT":
      return `Autonomous debit unavailable. Give the user this payment link to complete the purchase: ${result.paymentLinkUrl}. Poll check_approval_status(requestId) instead of retrying checkout.`;
    case "AWAITING_HUMAN_APPROVAL":
      return `Autonomous debit was halted. Give the user this payment link and stop: ${result.paymentLinkUrl}. Poll check_approval_status(requestId) instead of retrying checkout.`;
    case "BLOCKED":
      return "The policy firewall denied this request. Do NOT retry, do NOT split the cart into smaller orders. Report the reason to the user.";
    case "DEBIT_IN_PROGRESS":
    case "QUARANTINED_PENDING_RECONCILIATION":
      return "The gateway did not confirm this debit. The request is quarantined. Do NOT issue another debit for this cart — call check_approval_status(requestId) until it resolves.";
    case "MANDATE_REQUIRED":
      return "No active card mandate. Give the user the one-time ₹1 setup link, then re-check the mandate before retrying.";
    case "RETRY_DEDUPLICATED":
      return "This exact cart was already submitted. The original result is returned unchanged; no second charge was made.";
  }
}

/**
 * The full policy-gated checkout pipeline: re-price, evaluate, execute.
 */
export async function requestCheckout(input: CheckoutInput): Promise<CheckoutResult> {
  const requestedAt = new Date();
  const epochTimestamp = requestedAt.getTime();
  const agentId = input.agentId?.trim() || DEFAULT_AGENT_ID;

  const cart = await repriceCart(input.items ?? []);
  const key = idempotencyKey({
    agentId,
    cartSnapshot: input.items ?? [],
    epochTimestamp,
  });

  // F4 — idempotency quarantine. An identical cart inside the same minute
  // never produces a second debit.
  const duplicate = await prisma.agentRequest.findUnique({
    where: { idempotencyKey: key },
    include: { decision: true, approval: true, attempts: true },
  });
  if (duplicate) {
    await appendAuditEvent(
      "RETRY_DEDUPLICATED",
      { agentId, idempotencyKey: key, originalRequestId: duplicate.id, originalStatus: duplicate.status },
      duplicate.id,
    );
    const quarantined = duplicate.status === "DEBIT_IN_PROGRESS";
    const paymentStatus: PaymentStatus = quarantined
      ? "QUARANTINED_PENDING_RECONCILIATION"
      : "RETRY_DEDUPLICATED";
    const attempt = duplicate.attempts.at(-1);
    const base: Partial<CheckoutResult> = {
      amountFormatted: formatPaise(duplicate.subtotalPaise),
      paymentLinkUrl: duplicate.approval?.paymentLinkUrl ?? undefined,
    };
    return {
      requestId: duplicate.id,
      agentId,
      decision: (duplicate.decision?.decision ?? "DENY") as CheckoutResult["decision"],
      reasonCode: quarantined ? "QUARANTINE_LOCKED" : "IDEMPOTENT_REPLAY",
      reasonText: quarantined
        ? "A debit for this exact cart is already in flight and quarantined pending reconciliation. Duplicate debit blocked."
        : "This exact cart was already evaluated. Returning the original decision without re-charging.",
      paymentStatus,
      amountPaise: duplicate.subtotalPaise,
      amountFormatted: formatPaise(duplicate.subtotalPaise),
      items: JSON.parse(duplicate.itemsJson) as VerifiedItem[],
      rejectedItems: [],
      rules: duplicate.decision ? (JSON.parse(duplicate.decision.rulesJson) as PolicyEvaluation["rules"]) : [],
      paymentLinkUrl: duplicate.approval?.paymentLinkUrl ?? undefined,
      orderId: attempt?.orderId ?? undefined,
      paymentId: attempt?.paymentId ?? undefined,
      mandate: toMandateView(await getMandateRecord()),
      telemetry: {
        requestedAt: requestedAt.toISOString(),
        evaluatedAt: new Date().toISOString(),
        latencyMs: Date.now() - epochTimestamp,
        epochTimestamp,
      },
      idempotencyKey: key,
      gatewayMode: gatewayMode(),
      agentGuidance: guidanceFor(paymentStatus, base),
    };
  }

  const policy = await getPolicyConfig();
  const dailySpentPaise = await getDailySpentPaise();
  const windowStart = new Date(epochTimestamp - policy.velocityWindowSec * 1000);
  const recent = await prisma.agentRequest.findMany({
    where: { agentId, requestedAt: { gte: windowStart } },
    orderBy: { requestedAt: "desc" },
    select: { requestedAt: true },
  });
  const circuitBreakerUntilEpoch = await activeCircuitBreakerUntil(
    agentId,
    policy.velocityLockoutSec,
  );

  // S-09 — Session Binding & Context Validation
  const sessionId = input.sessionId?.trim() || input.sessionContext?.sessionId?.trim();
  let sessionHash: string | undefined;

  if (sessionId) {
    const session = await getSessionBinding(sessionId);
    if (!session) {
      const requestId = newRequestId();
      const createData: Record<string, unknown> = {
        id: requestId,
        agentId,
        reason: input.reason?.slice(0, 500) ?? "",
        cartJson: JSON.stringify(input.items ?? []),
        itemsJson: JSON.stringify(cart.verified),
        subtotalPaise: cart.subtotalPaise,
        idempotencyKey: key,
        status: "REJECTED",
        requestedAt,
        evaluatedAt: new Date(),
        epochTimestamp: BigInt(epochTimestamp),
        latencyMs: Date.now() - epochTimestamp,
      };
      if (sessionId) createData.sessionId = sessionId;

      await (prisma.agentRequest.create as any)({
        data: createData,
      });
      await appendAuditEvent(
        "SESSION_SECURITY_ALERT",
        {
          sessionId,
          agentId,
          reasonCode: "SESSION_NOT_FOUND",
          reasonText: `Session '${sessionId}' was not found in the gateway directory.`,
        },
        requestId,
      );
      return {
        requestId,
        agentId,
        sessionId,
        decision: "DENY",
        reasonCode: "SESSION_NOT_FOUND",
        reasonText: `Session '${sessionId}' was not found in the gateway directory.`,
        paymentStatus: "BLOCKED",
        amountPaise: cart.subtotalPaise,
        amountFormatted: formatPaise(cart.subtotalPaise),
        items: cart.verified,
        rejectedItems: cart.rejectedItems,
        rules: [
          {
            id: "S-09",
            label: "Session Binding & Context Security",
            passed: false,
            detail: `Session '${sessionId}' was not found in database.`,
          },
        ],
        mandate: toMandateView(await getMandateRecord()),
        telemetry: {
          requestedAt: requestedAt.toISOString(),
          evaluatedAt: new Date().toISOString(),
          latencyMs: Date.now() - epochTimestamp,
          epochTimestamp,
        },
        idempotencyKey: key,
        gatewayMode: gatewayMode(),
        agentGuidance: "Session invalid or missing. Re-authenticate to establish a valid session binding.",
      };
    }

    if (input.sessionContext) {
      const validation = await validateSessionContext(input.sessionContext, session, cart.subtotalPaise);
      if (!validation.valid) {
        const requestId = newRequestId();
        const createData: Record<string, unknown> = {
          id: requestId,
          agentId,
          reason: input.reason?.slice(0, 500) ?? "",
          cartJson: JSON.stringify(input.items ?? []),
          itemsJson: JSON.stringify(cart.verified),
          subtotalPaise: cart.subtotalPaise,
          idempotencyKey: key,
          status: "REJECTED",
          requestedAt,
          evaluatedAt: new Date(),
          epochTimestamp: BigInt(epochTimestamp),
          latencyMs: Date.now() - epochTimestamp,
        };
        if (sessionId) createData.sessionId = sessionId;

        await (prisma.agentRequest.create as any)({
          data: createData,
        });
        await appendAuditEvent(
          "SESSION_SECURITY_ALERT",
          {
            sessionId,
            agentId,
            reasonCode: validation.reasonCode,
            reasonText: validation.reasonText,
            receivedContext: input.sessionContext,
          },
          requestId,
        );
        return {
          requestId,
          agentId,
          sessionId,
          decision: "DENY",
          reasonCode: validation.reasonCode ?? "SESSION_USER_AGENT_MISMATCH",
          reasonText: validation.reasonText ?? "Session context validation failed.",
          paymentStatus: "BLOCKED",
          amountPaise: cart.subtotalPaise,
          amountFormatted: formatPaise(cart.subtotalPaise),
          items: cart.verified,
          rejectedItems: cart.rejectedItems,
          rules: [
            {
              id: "S-09",
              label: "Session Binding & Context Security",
              passed: false,
              detail: validation.reasonText ?? "Session context validation failed.",
            },
          ],
          mandate: toMandateView(await getMandateRecord()),
          telemetry: {
            requestedAt: requestedAt.toISOString(),
            evaluatedAt: new Date().toISOString(),
            latencyMs: Date.now() - epochTimestamp,
            epochTimestamp,
          },
          idempotencyKey: key,
          gatewayMode: gatewayMode(),
          agentGuidance: "Session context verification failed. Transaction blocked to prevent session hijacking.",
        };
      }
      sessionHash = validation.sessionHash;
      await appendAuditEvent("SESSION_VALIDATED", {
        sessionId,
        agentId,
        sessionHash,
      });
    }
  }

  const requestId = newRequestId();
  const requestData: Record<string, unknown> = {
    id: requestId,
    agentId,
    reason: input.reason?.slice(0, 500) ?? "",
    cartJson: JSON.stringify(input.items ?? []),
    itemsJson: JSON.stringify(cart.verified),
    subtotalPaise: cart.subtotalPaise,
    idempotencyKey: key,
    status: "EVALUATING",
    requestedAt,
    epochTimestamp: BigInt(epochTimestamp),
  };
  if (sessionId) requestData.sessionId = sessionId;
  if (sessionHash) requestData.sessionHash = sessionHash;

  await (prisma.agentRequest.create as any)({
    data: requestData,
  });
  await appendAuditEvent(
    "AGENT_REQUEST",
    {
      agentId,
      ...(sessionId ? { sessionId } : {}),
      ...(sessionHash ? { sessionHash } : {}),
      reason: input.reason,
      claimedCart: input.items ?? [],
      serverVerifiedItems: cart.verified,
      serverSubtotalPaise: cart.subtotalPaise,
      priceMismatches: cart.priceMismatches,
    },
    requestId,
  );

  const evaluation = evaluatePolicy(policy, {
    items: cart.verified,
    subtotalPaise: cart.subtotalPaise,
    dailySpentPaise,
    recentRequestEpochs: recent.map((entry) => entry.requestedAt.getTime()),
    nowEpoch: epochTimestamp,
    circuitBreakerUntilEpoch,
    unknownSkus: cart.unknownSkus,
    outOfStockSkus: cart.outOfStockSkus,
  });

  const evaluatedAt = new Date();
  await prisma.policyDecision.create({
    data: {
      requestId,
      decision: evaluation.decision,
      reasonCode: evaluation.reasonCode,
      reasonText: evaluation.reasonText,
      rulesJson: JSON.stringify(evaluation.rules),
      amountPaise: evaluation.amountPaise,
      evaluatedAt,
    },
  });
  await appendAuditEvent(
    "POLICY_DECISION_EVALUATED",
    {
      decision: evaluation.decision,
      reasonCode: evaluation.reasonCode,
      reasonText: evaluation.reasonText,
      amountPaise: evaluation.amountPaise,
      dailySpentPaise,
      rules: evaluation.rules,
    },
    requestId,
  );

  let paymentStatus: PaymentStatus = "BLOCKED";
  let paymentLinkUrl: string | undefined;
  let orderId: string | undefined;
  let paymentId: string | undefined;
  let debitedAt: Date | undefined;
  let requestStatus = "REJECTED";
  let reasonCode = evaluation.reasonCode as string;
  let reasonText = evaluation.reasonText;

  if (evaluation.decision === "ALLOW") {
    const mandate = await getMandateRecord();
    if (mandate.status !== "ACTIVE" || !mandate.tokenId) {
      // F1 — no tokenized mandate yet: hand back the one-time ₹1 setup link.
      const view = await getOrCreateMandateSetupLink();
      paymentStatus = "MANDATE_REQUIRED";
      paymentLinkUrl = view.setupLinkUrl ?? undefined;
      requestStatus = "MANDATE_REQUIRED";
      reasonCode = "MANDATE_REQUIRED";
      reasonText =
        "Policy allows this purchase, but no tokenized card mandate is active. Complete the one-time ₹1 verification to enable zero-OTP autonomous debits.";
    } else if (evaluation.amountPaise > mandate.maxDebitPaise) {
      paymentStatus = "BLOCKED";
      requestStatus = "REJECTED";
      reasonCode = "MANDATE_DEBIT_CAP_EXCEEDED";
      reasonText = `Amount exceeds the mandate's per-debit cap (${evaluation.amountPaise} paise > ${mandate.maxDebitPaise} paise).`;
    } else {
      try {
        const order = await razorpayGateway.createOrder({
          amountPaise: evaluation.amountPaise,
          receipt: requestId,
          notes: { agentId, requestId },
        });
        orderId = order.orderId;
        const payment = await razorpayGateway.debitMandate({
          amountPaise: evaluation.amountPaise,
          orderId: order.orderId,
          tokenId: mandate.tokenId,
          customerId: mandate.customerId ?? undefined,
          simulateTimeout: input.simulateTimeout,
        });
        paymentId = payment.paymentId;
        debitedAt = new Date();
        paymentStatus = "PAID";
        requestStatus = "PAID";
        await prisma.paymentAttempt.create({
          data: {
            requestId,
            mode: "MANDATE_AUTO_DEBIT",
            status: "PAID",
            amountPaise: evaluation.amountPaise,
            orderId,
            paymentId,
            idempotencyKey: key,
          },
        });
        await appendAuditEvent(
          "MANDATE_AUTO_DEBIT_CAPTURED",
          {
            orderId,
            paymentId,
            amountPaise: evaluation.amountPaise,
            cardNetwork: mandate.cardNetwork,
            cardLast4: mandate.cardLast4,
            otpPrompts: 0,
            simulated: payment.simulated,
          },
          requestId,
        );
      } catch (error) {
        if (error instanceof RecurringUnsupportedError) {
          // Not ambiguous: no money moved and none will. Quarantining here
          // would strand the request, so fall back to a real hosted payment
          // link, which does produce a payment visible in the dashboard.
          const link = await razorpayGateway.createPaymentLink({
            amountPaise: evaluation.amountPaise,
            description: input.reason?.slice(0, 200) || "SpendBoundary purchase",
            referenceId: requestId,
          });
          paymentLinkUrl = link.shortUrl;
          paymentStatus = "AWAITING_PAYMENT";
          requestStatus = "AWAITING_APPROVAL";
          reasonCode = "MANDATE_NOT_CHARGEABLE";
          reasonText = `${error.message} A hosted payment link was issued instead; no autonomous debit was attempted.`;
          await prisma.approval.create({
            data: {
              requestId,
              status: "PENDING",
              amountPaise: evaluation.amountPaise,
              paymentLinkId: link.linkId,
              paymentLinkUrl: link.shortUrl,
            },
          });
          await prisma.paymentAttempt.create({
            data: {
              requestId,
              mode: "PAYMENT_LINK",
              status: "CREATED",
              amountPaise: evaluation.amountPaise,
              orderId,
              paymentLinkUrl: link.shortUrl,
              errorText: error.message,
              idempotencyKey: key,
            },
          });
          await appendAuditEvent(
            "PAYMENT_ATTEMPT_RECORDED",
            {
              state: "MANDATE_NOT_CHARGEABLE",
              orderId,
              amountPaise: evaluation.amountPaise,
              error: error.message,
              fallbackPaymentLinkUrl: link.shortUrl,
              quarantined: false,
            },
            requestId,
          );
        } else {
          // R-03 — ambiguous gateway status quarantines the request instead of
          // reporting a failure the agent would try to "fix" with a retry.
          const timedOut = error instanceof GatewayTimeoutError;
          paymentStatus = "DEBIT_IN_PROGRESS";
          requestStatus = "DEBIT_IN_PROGRESS";
          reasonCode = "QUARANTINED_PENDING_RECONCILIATION";
          reasonText = timedOut
            ? "The gateway did not confirm this debit before timing out. The request is quarantined; duplicate debits for this cart are blocked until reconciliation completes."
            : `Gateway error during debit: ${(error as Error).message}. Request quarantined.`;
          await prisma.paymentAttempt.create({
            data: {
              requestId,
              mode: "MANDATE_AUTO_DEBIT",
              status: "DEBIT_IN_PROGRESS",
              amountPaise: evaluation.amountPaise,
              orderId,
              errorText: (error as Error).message,
              idempotencyKey: key,
            },
          });
          await appendAuditEvent(
            "PAYMENT_ATTEMPT_RECORDED",
            {
              state: "DEBIT_IN_PROGRESS",
              orderId,
              amountPaise: evaluation.amountPaise,
              error: (error as Error).message,
              quarantined: true,
            },
            requestId,
          );
        }
      }
    }
  } else if (evaluation.decision === "REVIEW") {
    const link = await razorpayGateway.createPaymentLink({
      amountPaise: evaluation.amountPaise,
      description: input.reason?.slice(0, 200) || "SpendBoundary human-reviewed purchase",
      referenceId: requestId,
    });
    paymentLinkUrl = link.shortUrl;
    paymentStatus = "AWAITING_HUMAN_APPROVAL";
    requestStatus = "AWAITING_APPROVAL";
    await prisma.approval.create({
      data: {
        requestId,
        status: "PENDING",
        amountPaise: evaluation.amountPaise,
        paymentLinkId: link.linkId,
        paymentLinkUrl: link.shortUrl,
      },
    });
    await prisma.paymentAttempt.create({
      data: {
        requestId,
        mode: "PAYMENT_LINK",
        status: "CREATED",
        amountPaise: evaluation.amountPaise,
        paymentLinkUrl: link.shortUrl,
        idempotencyKey: key,
      },
    });
    await appendAuditEvent(
      "APPROVAL_SUBMITTED",
      {
        kind: "HUMAN_REVIEW_LINK_CREATED",
        paymentLinkId: link.linkId,
        paymentLinkUrl: link.shortUrl,
        amountPaise: evaluation.amountPaise,
        simulated: link.simulated,
      },
      requestId,
    );
  }

  const latencyMs = Date.now() - epochTimestamp;
  await prisma.agentRequest.update({
    where: { id: requestId },
    data: { status: requestStatus, evaluatedAt, debitedAt, latencyMs },
  });

  const result: CheckoutResult = {
    requestId,
    agentId,
    sessionId: sessionId ?? undefined,
    sessionHash: sessionHash ?? undefined,
    decision: evaluation.decision,
    reasonCode,
    reasonText,
    paymentStatus,
    amountPaise: evaluation.amountPaise,
    amountFormatted: formatPaise(evaluation.amountPaise),
    items: cart.verified,
    rejectedItems: cart.rejectedItems,
    rules: evaluation.rules,
    paymentLinkUrl,
    orderId,
    paymentId,
    mandate: toMandateView(await getMandateRecord()),
    telemetry: {
      requestedAt: requestedAt.toISOString(),
      evaluatedAt: evaluatedAt.toISOString(),
      debitedAt: debitedAt?.toISOString(),
      latencyMs,
      epochTimestamp,
    },
    idempotencyKey: key,
    gatewayMode: gatewayMode(),
    agentGuidance: "",
  };
  result.agentGuidance = guidanceFor(paymentStatus, result);
  return result;
}

/**
 * F3 — polls Razorpay for a pending review link and reconciles quarantined
 * debits. This is what the agent calls instead of retrying a checkout.
 */
export async function checkApprovalStatus(requestId: string) {
  const request = await prisma.agentRequest.findUnique({
    where: { id: requestId },
    include: { decision: true, approval: true, attempts: true },
  });
  if (!request) {
    return { found: false as const, requestId, message: "No such request id." };
  }

  let status = request.status;
  let reconciled = false;

  if (request.approval && request.approval.status === "PENDING" && request.approval.paymentLinkId) {
    const link = await razorpayGateway.fetchPaymentLink(request.approval.paymentLinkId);
    if (link.status === "paid") {
      await markApprovalPaid(requestId, link.paymentId);
      status = "PAID";
      reconciled = true;
    } else if (link.status === "cancelled" || link.status === "expired") {
      await prisma.approval.update({
        where: { requestId },
        data: { status: "EXPIRED", decidedAt: new Date() },
      });
      await prisma.agentRequest.update({ where: { id: requestId }, data: { status: "EXPIRED" } });
      status = "EXPIRED";
      reconciled = true;
    }
  }

  if (status === "DEBIT_IN_PROGRESS") {
    // Quarantine stays until an operator or reconciliation resolves it. The
    // agent is told to wait, never to charge again.
    return {
      found: true as const,
      requestId,
      status,
      paymentStatus: "QUARANTINED_PENDING_RECONCILIATION" as PaymentStatus,
      amountPaise: request.subtotalPaise,
      amountFormatted: formatPaise(request.subtotalPaise),
      decision: request.decision?.decision ?? "ALLOW",
      paymentLinkUrl: request.approval?.paymentLinkUrl ?? null,
      reconciled,
      agentGuidance:
        "Still quarantined. Do NOT submit another debit for this cart. Poll again or ask the operator to reconcile.",
    };
  }

  const fresh = await prisma.agentRequest.findUnique({
    where: { id: requestId },
    include: { decision: true, approval: true, attempts: true },
  });

  return {
    found: true as const,
    requestId,
    status,
    paymentStatus: (status === "PAID"
      ? "PAID"
      : status === "AWAITING_APPROVAL"
        ? "AWAITING_HUMAN_APPROVAL"
        : "BLOCKED") as PaymentStatus,
    amountPaise: request.subtotalPaise,
    amountFormatted: formatPaise(request.subtotalPaise),
    decision: request.decision?.decision ?? "DENY",
    reasonText: request.decision?.reasonText ?? "",
    paymentLinkUrl: fresh?.approval?.paymentLinkUrl ?? null,
    orderId: fresh?.attempts.at(-1)?.orderId ?? null,
    paymentId: fresh?.attempts.at(-1)?.paymentId ?? null,
    reconciled,
    agentGuidance:
      status === "PAID"
        ? "Payment captured. Confirm the order to the user and stop."
        : status === "AWAITING_APPROVAL"
          ? "Still awaiting the human. Keep polling; do not create another payment."
          : "Terminal state. Do not retry.",
  };
}

/** Marks a reviewed request paid — used by reconciliation and by the operator. */
export async function markApprovalPaid(requestId: string, paymentId?: string, decidedBy = "reconciliation") {
  const approval = await prisma.approval.findUnique({ where: { requestId } });
  if (!approval) throw new Error("No approval record for this request");

  await prisma.approval.update({
    where: { requestId },
    data: { status: "APPROVED", decidedAt: new Date(), decidedBy },
  });
  await prisma.paymentAttempt.create({
    data: {
      requestId,
      mode: "PAYMENT_LINK",
      status: "PAID",
      amountPaise: approval.amountPaise,
      paymentId: paymentId ?? `pay_link_${requestId}`,
      paymentLinkUrl: approval.paymentLinkUrl,
      idempotencyKey: `${requestId}_link_capture`,
    },
  });
  await prisma.agentRequest.update({
    where: { id: requestId },
    data: { status: "PAID", debitedAt: new Date() },
  });
  await appendAuditEvent(
    "PAYMENT_CAPTURED",
    {
      via: "HOSTED_PAYMENT_LINK",
      amountPaise: approval.amountPaise,
      paymentId: paymentId ?? null,
      decidedBy,
    },
    requestId,
  );
}

export async function rejectApproval(requestId: string, decidedBy = "merchant") {
  await prisma.approval.update({
    where: { requestId },
    data: { status: "REJECTED", decidedAt: new Date(), decidedBy },
  });
  await prisma.agentRequest.update({ where: { id: requestId }, data: { status: "REJECTED" } });
  await appendAuditEvent("APPROVAL_SUBMITTED", { kind: "HUMAN_REJECTED", decidedBy }, requestId);
}
