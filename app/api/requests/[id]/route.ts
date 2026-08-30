import { NextResponse } from "next/server";
import { checkApprovalStatus } from "@/lib/checkout";
import { jsonSafe } from "@/lib/mcp";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const status = await checkApprovalStatus(id);
  return new NextResponse(JSON.stringify(status, jsonSafe), {
    status: status.found ? 200 : 404,
    headers: { "content-type": "application/json" },
  });
}
