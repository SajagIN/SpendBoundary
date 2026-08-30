"use client";

import { useState } from "react";
import { DecisionBadge, JsonDrawer, Panel, StatusPill, formatPaise } from "./ui";

type CartItem = { sku: string; quantity: number; claimedPricePaise?: number };

type CheckoutResult = {
  requestId: string;
  agentId: string;
  decision: "ALLOW" | "REVIEW" | "DENY";
  reasonCode: string;
  reasonText: string;
  paymentStatus: string;
  amountPaise: number;
  amountFormatted: string;
  items: {
    sku: string;
    name: string;
    category: string;
    unitPricePaise: number;
    quantity: number;
    lineTotalPaise: number;
  }[];
  rejectedItems: { sku: string; problem: string }[];
  rules: { id: string; label: string; passed: boolean; detail: string }[];
  paymentLinkUrl?: string;
  orderId?: string;
  paymentId?: string;
  telemetry: {
    requestedAt: string;
    evaluatedAt: string;
    debitedAt?: string;
    latencyMs: number;
    epochTimestamp: number;
  };
  idempotencyKey: string;
  gatewayMode: string;
  simulated: boolean;
  agentGuidance: string;
};

type ToolCall = {
  id: string;
  tool: string;
  args: unknown;
  response: unknown;
  latencyMs: number;
  at: string;
};

type Product = { sku: string; name: string; pricePaise: number; category: string };

const SCENARIOS: {
  key: string;
  label: string;
  hint: string;
  reason: string;
  items: CartItem[];
  repeat?: number;
  simulateTimeout?: boolean;
}[] = [
  {
    key: "notebook",
    label: "Buy ₹350 notebook",
    hint: "AC-01 · autonomous zero-OTP debit",
    reason: "User asked for a dotted notebook for meeting notes.",
    items: [{ sku: "SKU-NOTE-350", quantity: 1 }],
  },
  {
    key: "supplies",
    label: "Buy ₹500 office supplies",
    hint: "Sub-threshold multi-line cart",
    reason: "Restocking the office supply cupboard.",
    items: [
      { sku: "SKU-PAPER-500", quantity: 1 },
      { sku: "SKU-PEN-120", quantity: 1 },
    ],
  },
  {
    key: "lamp",
    label: "Review ₹1,500 desk lamp",
    hint: "AC-02 · human approval + payment link",
    reason: "User wants a smart desk lamp for the home office.",
    items: [{ sku: "SKU-LAMP-1500", quantity: 1 }],
  },
  {
    key: "miner",
    label: "Blocked ₹5,000 crypto miner",
    hint: "AC-03 · category not whitelisted",
    reason: "Agent tried to buy a crypto mining licence.",
    items: [{ sku: "SKU-MINER-5000", quantity: 1 }],
  },
  {
    key: "chair",
    label: "Overspend ₹8,000 chair",
    hint: "Single-order cap breach",
    reason: "User asked for an ergonomic chair.",
    items: [{ sku: "SKU-CHAIR-8000", quantity: 1 }],
  },
  {
    key: "velocity",
    label: "Velocity burst ×4",
    hint: "AC-04 · 4th request trips the breaker",
    reason: "Runaway agent loop submitting repeated carts.",
    items: [{ sku: "SKU-PEN-120", quantity: 1 }],
    repeat: 4,
  },
  {
    key: "timeout",
    label: "Gateway timeout on debit",
    hint: "AC-05 · quarantine, then blocked retry",
    reason: "Network timeout mid-debit; agent believes it failed.",
    items: [{ sku: "SKU-STAND-750", quantity: 1 }],
    simulateTimeout: true,
  },
  {
    key: "hallucinated",
    label: "Hallucinated ₹1 price",
    hint: "Server re-prices, agent claim discarded",
    reason: "Agent claims the lamp costs ₹1.",
    items: [{ sku: "SKU-LAMP-1500", quantity: 1, claimedPricePaise: 100 }],
  },
];

export default function AgentConsole({
  products,
  onMutated,
}: {
  products: Product[];
  onMutated: () => void;
}) {
  const [calls, setCalls] = useState<ToolCall[]>([]);
  const [results, setResults] = useState<CheckoutResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("Custom cart submitted from the agent console.");
  const [cart, setCart] = useState<CartItem[]>([{ sku: "SKU-NOTE-350", quantity: 1 }]);

  const latest = results[0];

  async function callCheckout(items: CartItem[], why: string, simulateTimeout = false) {
    const startedAt = performance.now();
    const payload = { items, reason: why, agentId: "agent_demo_console", simulateTimeout };
    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await response.json()) as CheckoutResult;
    const latencyMs = Math.round(performance.now() - startedAt);

    setCalls((previous) =>
      [
        {
          id: `${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
          tool: "request_checkout",
          args: payload,
          response: data,
          latencyMs,
          at: new Date().toLocaleTimeString(),
        },
        ...previous,
      ].slice(0, 25),
    );
    setResults((previous) => [data, ...previous].slice(0, 10));
    return data;
  }

  async function runScenario(scenario: (typeof SCENARIOS)[number]) {
    setBusy(true);
    try {
      const times = scenario.repeat ?? 1;
      for (let index = 0; index < times; index += 1) {
        // Distinct quantities keep each burst request a distinct cart, so the
        // velocity limiter is what fires rather than the idempotency lock.
        const items = scenario.repeat
          ? scenario.items.map((item) => ({ ...item, quantity: item.quantity + index }))
          : scenario.items;
        await callCheckout(items, scenario.reason, scenario.simulateTimeout);
      }
      if (scenario.key === "timeout") {
        // Immediately re-submit the identical cart: the quarantine must block it.
        await callCheckout(scenario.items, scenario.reason, false);
      }
    } finally {
      setBusy(false);
      onMutated();
    }
  }

  async function submitCustom() {
    setBusy(true);
    try {
      await callCheckout(cart.filter((item) => item.sku), reason);
    } finally {
      setBusy(false);
      onMutated();
    }
  }

  function updateCartItem(index: number, patch: Partial<CartItem>) {
    setCart((previous) => previous.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  const cartPreviewPaise = cart.reduce((total, item) => {
    const product = products.find((entry) => entry.sku === item.sku);
    return total + (product ? product.pricePaise * item.quantity : 0);
  }, 0);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Panel title="1-Click Scenarios" subtitle="Each one exercises a row of the acceptance matrix.">
          <div className="grid gap-2">
            {SCENARIOS.map((scenario) => (
              <button
                key={scenario.key}
                className="btn text-left"
                disabled={busy}
                onClick={() => runScenario(scenario)}
              >
                <div className="font-medium">{scenario.label}</div>
                <div className="text-xs text-slate-400">{scenario.hint}</div>
              </button>
            ))}
          </div>
        </Panel>

        <Panel title="Custom Cart" subtitle="Build any cart and push it through the firewall.">
          <label className="label">Agent reason</label>
          <textarea
            className="input mt-1 h-16 resize-none"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />

          <div className="mt-3 space-y-2">
            {cart.map((item, index) => (
              <div key={index} className="flex gap-2">
                <select
                  className="input"
                  value={item.sku}
                  onChange={(event) => updateCartItem(index, { sku: event.target.value })}
                >
                  {products.map((product) => (
                    <option key={product.sku} value={product.sku}>
                      {product.name} — {formatPaise(product.pricePaise)}
                    </option>
                  ))}
                </select>
                <input
                  className="input w-20"
                  type="number"
                  min={1}
                  value={item.quantity}
                  onChange={(event) =>
                    updateCartItem(index, { quantity: Math.max(1, Number(event.target.value) || 1) })
                  }
                />
                <button
                  className="btn px-2"
                  onClick={() => setCart((previous) => previous.filter((_, i) => i !== index))}
                  disabled={cart.length === 1}
                  aria-label="Remove line"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <div className="mt-3 flex items-center justify-between">
            <button
              className="btn"
              onClick={() =>
                setCart((previous) => [...previous, { sku: products[0]?.sku ?? "", quantity: 1 }])
              }
            >
              + Add line
            </button>
            <span className="font-mono text-sm text-slate-300">{formatPaise(cartPreviewPaise)}</span>
          </div>

          <button className="btn btn-primary mt-3 w-full" disabled={busy} onClick={submitCustom}>
            {busy ? "Evaluating…" : "request_checkout()"}
          </button>
        </Panel>
      </div>

      <div className="space-y-4">
        {latest ? (
          <Panel
            title="Policy Decision"
            subtitle={`Request ${latest.requestId}`}
            right={<DecisionBadge decision={latest.decision} />}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="glass px-3 py-2">
                <div className="label">Server-verified total</div>
                <div className="metric mt-1">{latest.amountFormatted}</div>
              </div>
              <div className="glass px-3 py-2">
                <div className="label">Payment status</div>
                <div className="mt-2">
                  <StatusPill status={latest.paymentStatus} />
                </div>
              </div>
              <div className="glass px-3 py-2">
                <div className="label">End-to-end latency</div>
                <div className="metric mt-1">{latest.telemetry.latencyMs} ms</div>
              </div>
            </div>

            {latest.simulated && (
              <div
                className="mt-3 rounded-lg px-3 py-2 text-sm"
                style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.45)" }}
              >
                <strong className="text-rose-300">SIMULATED — no money moved. </strong>
                <span className="text-slate-200">
                  The gateway is running its offline mock, so this will not appear in the Razorpay
                  dashboard. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET for real transactions.
                </span>
              </div>
            )}

            <p className="mt-3 text-sm text-slate-200">{latest.reasonText}</p>
            <p className="mt-2 rounded-lg px-3 py-2 text-xs text-slate-300"
               style={{ background: "rgba(99,102,241,0.10)", border: "1px solid rgba(99,102,241,0.3)" }}>
              <span className="font-semibold text-indigo-300">Instruction returned to the agent: </span>
              {latest.agentGuidance}
            </p>

            {latest.paymentLinkUrl && (
              <div
                className="mt-3 rounded-lg px-3 py-2 text-sm"
                style={{ background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.35)" }}
              >
                <div className="label">Hosted payment link (human OTP)</div>
                <a
                  className="font-mono text-sm text-amber-300 underline"
                  href={latest.paymentLinkUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {latest.paymentLinkUrl}
                </a>
              </div>
            )}

            {(latest.orderId || latest.paymentId) && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {latest.orderId && (
                  <div className="glass px-3 py-2">
                    <div className="label">Razorpay order</div>
                    <div className="hash mt-1">{latest.orderId}</div>
                  </div>
                )}
                {latest.paymentId && (
                  <div className="glass px-3 py-2">
                    <div className="label">Razorpay payment</div>
                    <div className="hash mt-1">{latest.paymentId}</div>
                  </div>
                )}
              </div>
            )}

            <h3 className="mt-5 text-sm font-semibold">Cart re-priced by the server</h3>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                  <th className="py-1">Item</th>
                  <th>Category</th>
                  <th className="text-right">Unit</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Line</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {latest.items.map((item) => (
                  <tr key={item.sku} className="border-t" style={{ borderColor: "var(--border)" }}>
                    <td className="py-1.5 font-sans">{item.name}</td>
                    <td className="font-sans text-slate-400">{item.category}</td>
                    <td className="text-right">{formatPaise(item.unitPricePaise)}</td>
                    <td className="text-right">{item.quantity}</td>
                    <td className="text-right">{formatPaise(item.lineTotalPaise)}</td>
                  </tr>
                ))}
                {latest.items.length === 0 && (
                  <tr>
                    <td className="py-2 font-sans text-slate-400" colSpan={5}>
                      No line items survived server verification.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {latest.rejectedItems.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-rose-300">
                {latest.rejectedItems.map((item) => (
                  <li key={item.sku}>
                    {item.sku}: {item.problem}
                  </li>
                ))}
              </ul>
            )}

            <h3 className="mt-5 text-sm font-semibold">Rule breakdown</h3>
            <div className="mt-2 space-y-1.5">
              {latest.rules.map((rule) => (
                <div
                  key={`${rule.id}-${rule.label}`}
                  className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs"
                  style={{
                    background: rule.passed ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.08)",
                    border: `1px solid ${rule.passed ? "rgba(16,185,129,0.25)" : "rgba(239,68,68,0.3)"}`,
                  }}
                >
                  <span>{rule.passed ? "✅" : "⛔"}</span>
                  <div>
                    <span className="font-mono text-slate-300">{rule.id}</span>{" "}
                    <span className="font-medium">{rule.label}</span>
                    <div className="text-slate-400">{rule.detail}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 grid gap-2 text-xs text-slate-400 sm:grid-cols-2">
              <div>
                <span className="label">requestedAt</span>
                <div className="font-mono">{latest.telemetry.requestedAt}</div>
              </div>
              <div>
                <span className="label">evaluatedAt</span>
                <div className="font-mono">{latest.telemetry.evaluatedAt}</div>
              </div>
              <div>
                <span className="label">debitedAt</span>
                <div className="font-mono">{latest.telemetry.debitedAt ?? "—"}</div>
              </div>
              <div>
                <span className="label">idempotency key</span>
                <div className="hash">{latest.idempotencyKey}</div>
              </div>
            </div>

            <JsonDrawer data={latest} label="Raw request_checkout response" />
          </Panel>
        ) : (
          <Panel title="Policy Decision" subtitle="Run a scenario to see the firewall evaluate a cart.">
            <p className="text-sm text-slate-400">
              Nothing evaluated yet. Pick a scenario on the left — every call goes through the same
              deterministic pipeline the MCP tools use.
            </p>
          </Panel>
        )}

        <Panel
          title="Tool Call Telemetry"
          subtitle="Every MCP tool invocation, newest first."
          right={<span className="chip" style={{ color: "#6366F1" }}>{calls.length} calls</span>}
        >
          {calls.length === 0 ? (
            <p className="text-sm text-slate-400">No tool calls yet.</p>
          ) : (
            <div className="space-y-2">
              {calls.map((call) => {
                const response = call.response as CheckoutResult;
                return (
                  <div key={call.id} className="glass px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="chip" style={{ color: "#6366F1" }}>
                        MCP
                      </span>
                      <span className="font-mono">{call.tool}</span>
                      <DecisionBadge decision={response?.decision ?? "MCP"} small />
                      <StatusPill status={response?.paymentStatus ?? "UNKNOWN"} />
                      <span className="ml-auto text-slate-400">
                        {call.at} · {call.latencyMs} ms
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-slate-400">
                      {response?.amountFormatted} — {response?.reasonCode}
                    </div>
                    <JsonDrawer data={{ args: call.args, response: call.response }} label="Inspect payload" />
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
