import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { appendAuditEvent } from "@/lib/audit";
import { getPolicyLimits } from "@/lib/mcp";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getPolicyLimits());
}

const INT_FIELDS = [
  "maxOrderPaise",
  "dailyCapPaise",
  "approvalThresholdPaise",
  "velocityMaxRequests",
  "velocityWindowSec",
  "velocityLockoutSec",
] as const;

/** Live policy editing from the dashboard sliders. Integers only (R-01). */
export async function PATCH(request: Request) {
  const body = await request.json().catch(() => ({}));
  const data: Record<string, number | string> = {};

  for (const field of INT_FIELDS) {
    if (body[field] !== undefined) {
      const value = Number(body[field]);
      if (!Number.isInteger(value) || value < 0) {
        return NextResponse.json(
          { error: `${field} must be a non-negative integer` },
          { status: 400 },
        );
      }
      data[field] = value;
    }
  }
  if (Array.isArray(body.allowedCategories)) {
    data.allowedCategories = body.allowedCategories.map(String).join(",");
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No recognised policy fields supplied" }, { status: 400 });
  }

  await prisma.policy.upsert({ where: { id: "default" }, update: data, create: { id: "default", ...data } });
  await appendAuditEvent("POLICY_UPDATED", data);
  return NextResponse.json(await getPolicyLimits());
}
