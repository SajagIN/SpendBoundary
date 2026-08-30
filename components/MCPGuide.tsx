"use client";

import { useState } from "react";
import { JsonDrawer, Panel } from "./ui";

const TOOL_PRESETS: { name: string; args: Record<string, unknown> }[] = [
  { name: "get_policy_limits", args: {} },
  { name: "search_catalogue", args: { query: "notebook" } },
  { name: "get_product", args: { sku: "SKU-LAMP-1500" } },
  {
    name: "request_checkout",
    args: {
      items: [{ sku: "SKU-NOTE-350", quantity: 1 }],
      reason: "Simulator: buy one notebook",
      agentId: "agent_mcp_simulator",
    },
  },
  { name: "check_approval_status", args: { requestId: "req_paste_one_here" } },
];

export default function MCPGuide({ projectPath }: { projectPath: string }) {
  const [selected, setSelected] = useState(0);
  const [argsText, setArgsText] = useState(JSON.stringify(TOOL_PRESETS[0].args, null, 2));
  const [response, setResponse] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const claudeConfig = JSON.stringify(
    {
      mcpServers: {
        spendboundary: {
          command: "npx",
          args: ["-y", "tsx", `${projectPath.replace(/\\/g, "/")}/scripts/mcp-server.ts`],
          env: { SPENDBOUNDARY_BASE_URL: "http://localhost:3000" },
        },
      },
    },
    null,
    2,
  );

  async function copy(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  }

  async function invoke() {
    setBusy(true);
    try {
      const args = JSON.parse(argsText) as Record<string, unknown>;
      const rpcResponse = await fetch("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name: TOOL_PRESETS[selected].name, arguments: args },
        }),
      });
      setResponse(await rpcResponse.json());
    } catch (error) {
      setResponse({ error: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <Panel
          title="Claude Desktop (stdio MCP)"
          subtitle="Add this to claude_desktop_config.json, then restart Claude Desktop."
          right={
            <button className="btn" onClick={() => copy(claudeConfig, "claude")}>
              {copied === "claude" ? "Copied" : "Copy"}
            </button>
          }
        >
          <pre className="max-h-64 overflow-auto rounded-lg p-3 font-mono text-[11px] text-slate-300"
               style={{ background: "rgba(0,0,0,0.3)" }}>
            {claudeConfig}
          </pre>
          <p className="mt-2 text-xs text-slate-400">
            Windows: <span className="font-mono">%APPDATA%\Claude\claude_desktop_config.json</span> ·
            macOS: <span className="font-mono">~/Library/Application Support/Claude/claude_desktop_config.json</span>
          </p>
          <p className="mt-2 text-xs text-slate-400">
            Keep <span className="font-mono">npm run dev</span> running — the stdio server proxies
            every tool call to the gateway at{" "}
            <span className="font-mono">http://localhost:3000/api/mcp</span>.
          </p>
        </Panel>

        <Panel title="ChatGPT Custom GPT Actions" subtitle="OpenAPI 3.1 over the same tool surface.">
          <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-300">
            <li>Create a Custom GPT, open Configure → Actions → Create new action.</li>
            <li>
              Import the schema from{" "}
              <span className="font-mono text-xs">http://localhost:3000/openapi.json</span> (expose the
              port with a tunnel if ChatGPT must reach it).
            </li>
            <li>Set authentication to None — the firewall holds the payment credentials, not the agent.</li>
            <li>
              After changing the URL, start a <strong>brand new chat</strong>. ChatGPT caches the
              action schema per thread (Incident E07).
            </li>
          </ol>
          <button className="btn mt-3" onClick={() => copy(`${window.location.origin}/openapi.json`, "openapi")}>
            {copied === "openapi" ? "Copied" : "Copy OpenAPI URL"}
          </button>
        </Panel>
      </div>

      <Panel title="In-Browser MCP Simulator" subtitle="Fires real JSON-RPC 2.0 at /api/mcp.">
        <label className="label">Tool</label>
        <select
          className="input mt-1"
          value={selected}
          onChange={(event) => {
            const index = Number(event.target.value);
            setSelected(index);
            setArgsText(JSON.stringify(TOOL_PRESETS[index].args, null, 2));
            setResponse(null);
          }}
        >
          {TOOL_PRESETS.map((preset, index) => (
            <option key={preset.name} value={index}>
              {preset.name}
            </option>
          ))}
        </select>

        <label className="label mt-3 block">Arguments (JSON)</label>
        <textarea
          className="input mt-1 h-40 font-mono text-xs"
          value={argsText}
          onChange={(event) => setArgsText(event.target.value)}
        />

        <button className="btn btn-primary mt-3 w-full" disabled={busy} onClick={invoke}>
          {busy ? "Calling…" : `tools/call → ${TOOL_PRESETS[selected].name}`}
        </button>

        {response !== null && <JsonDrawer data={response} label="JSON-RPC response" />}

        <div className="mt-4 rounded-lg px-3 py-2 text-xs text-slate-400"
             style={{ background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.25)" }}>
          The agent never sees a card number, a token or a Razorpay key. It sees SKUs, policy limits
          and a decision.
        </div>
      </Panel>
    </div>
  );
}
