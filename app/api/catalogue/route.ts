import { NextResponse } from "next/server";
import { callTool } from "@/lib/mcp";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const result = await callTool("search_catalogue", {
    query: url.searchParams.get("query") ?? "",
    category: url.searchParams.get("category") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 50),
  });
  return NextResponse.json(result);
}
