import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getPolicyConfig, getDailySpentPaise } from "@/lib/checkout";
import { getOrCreateMandateSetupLink } from "@/lib/mandate";
import { loadAndVerifyChain } from "@/lib/audit";
import { formatPaise } from "@/lib/money";
import { gatewayMode } from "@/lib/razorpay";
import { jsonSafe } from "@/lib/mcp";

export const dynamic = "force-dynamic";

/** Single fetch that backs the whole top KPI bar plus the request timeline. */
export async function GET() {
  try {
    const [policy, dailySpentPaise, mandate, chain] = await Promise.all([
      getPolicyConfig(),
      getDailySpentPaise(),
      getOrCreateMandateSetupLink(),
      loadAndVerifyChain(),
    ]);

    const [pendingApprovals, requests, decisionCounts] = await Promise.all([
      prisma.approval.count({ where: { status: "PENDING" } }),
      prisma.agentRequest.findMany({
        orderBy: { requestedAt: "desc" },
        take: 25,
        include: { decision: true, approval: true, attempts: true },
      }),
      prisma.policyDecision.groupBy({ by: ["decision"], _count: { decision: true } }),
    ]);

    const latencies = requests.map((request) => request.latencyMs ?? 0).filter(Boolean);

    return new NextResponse(
      JSON.stringify(
        {
          gatewayMode: gatewayMode(),
          demoMode: process.env.DEMO_MODE !== "false",
          policy: {
            ...policy,
            approvalThresholdFormatted: formatPaise(policy.approvalThresholdPaise),
            maxOrderFormatted: formatPaise(policy.maxOrderPaise),
            dailyCapFormatted: formatPaise(policy.dailyCapPaise),
          },
          spend: {
            dailySpentPaise,
            dailySpentFormatted: formatPaise(dailySpentPaise),
            dailyCapFormatted: formatPaise(policy.dailyCapPaise),
            usedPercent:
              policy.dailyCapPaise > 0
                ? Math.min(Math.round((dailySpentPaise * 100) / policy.dailyCapPaise), 100)
                : 0,
          },
          mandate,
          pendingApprovals,
          ledger: {
            length: chain.verification.length,
            valid: chain.verification.valid,
            brokenIndex: chain.verification.brokenIndex,
            reason: chain.verification.reason,
            headHash: chain.verification.headHash,
          },
          decisionCounts: Object.fromEntries(
            decisionCounts.map((row) => [row.decision, row._count.decision]),
          ),
          telemetry: {
            sampled: latencies.length,
            avgLatencyMs: latencies.length
              ? Math.round(latencies.reduce((total, value) => total + value, 0) / latencies.length)
              : 0,
            maxLatencyMs: latencies.length ? Math.max(...latencies) : 0,
          },
          requests: requests.map((request) => ({
            id: request.id,
            agentId: request.agentId,
            reason: request.reason,
            status: request.status,
            decision: request.decision?.decision ?? null,
            reasonCode: request.decision?.reasonCode ?? null,
            reasonText: request.decision?.reasonText ?? null,
            amountPaise: request.subtotalPaise,
            amountFormatted: formatPaise(request.subtotalPaise),
            items: JSON.parse(request.itemsJson) as unknown[],
            requestedAt: request.requestedAt.toISOString(),
            evaluatedAt: request.evaluatedAt?.toISOString() ?? null,
            debitedAt: request.debitedAt?.toISOString() ?? null,
            latencyMs: request.latencyMs,
            paymentLinkUrl: request.approval?.paymentLinkUrl ?? null,
            orderId: request.attempts.at(-1)?.orderId ?? null,
            paymentId: request.attempts.at(-1)?.paymentId ?? null,
          })),
        },
        jsonSafe,
      ),
      { headers: { "content-type": "application/json" } },
    );
  } catch (error) {
    console.error("GET /api/dashboard failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}
