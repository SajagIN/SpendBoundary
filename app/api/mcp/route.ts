import { NextResponse } from "next/server";
import { handleJsonRpc, SERVER_INFO, TOOLS, PROTOCOL_VERSION, jsonSafe } from "@/lib/mcp";

export const dynamic = "force-dynamic";

/** Discovery endpoint so a browser or curl can see the tool surface. */
export async function GET() {
  return NextResponse.json({
    protocol: "Model Context Protocol / JSON-RPC 2.0",
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: SERVER_INFO,
    endpoint: "/api/mcp",
    tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description })),
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }

  // A JSON-RPC batch is an array; single messages are objects.
  if (Array.isArray(body)) {
    const responses = [];
    for (const message of body) {
      const response = await handleJsonRpc(message);
      if (response) responses.push(response);
    }
    return new NextResponse(JSON.stringify(responses, jsonSafe), {
      headers: { "content-type": "application/json" },
    });
  }

  const response = await handleJsonRpc(body);
  if (!response) return new NextResponse(null, { status: 204 });
  return new NextResponse(JSON.stringify(response, jsonSafe), {
    headers: { "content-type": "application/json" },
  });
}
