#!/usr/bin/env node
/**
 * SpendBoundary stdio MCP server for Claude Desktop.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout. By default it runs
 * the gateway in-process against the same database the dashboard uses, so no
 * dev server is required. Set SPENDBOUNDARY_BASE_URL to proxy the calls to a
 * running Next.js instance instead (useful when the gateway is deployed).
 *
 * Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "spendboundary": {
 *         "command": "npx",
 *         "args": ["-y", "tsx", "<ABSOLUTE_PATH>/scripts/mcp-server.ts"]
 *       }
 *     }
 *   }
 */

import { createInterface } from "node:readline";
import { handleJsonRpc, jsonSafe } from "../lib/mcp";

const BASE_URL = process.env.SPENDBOUNDARY_BASE_URL?.replace(/\/$/, "");

// stdout carries protocol frames only; everything human-readable goes to stderr.
function log(message: string) {
  process.stderr.write(`[spendboundary-mcp] ${message}\n`);
}

async function dispatch(message: Record<string, unknown>) {
  if (BASE_URL) {
    const response = await fetch(`${BASE_URL}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    if (response.status === 204) return null;
    return (await response.json()) as Record<string, unknown>;
  }
  return handleJsonRpc(message);
}

function send(payload: unknown) {
  process.stdout.write(`${JSON.stringify(payload, jsonSafe)}\n`);
}

async function main() {
  log(BASE_URL ? `proxying tool calls to ${BASE_URL}/api/mcp` : "running in-process against the local database");

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }

    try {
      const response = await dispatch(message);
      if (response) send(response);
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: message.id ?? null,
        error: { code: -32000, message: (error as Error).message },
      });
    }
  }
}

main().catch((error) => {
  log(`fatal: ${(error as Error).message}`);
  process.exit(1);
});
