"use client";

import { useCallback, useEffect, useState } from "react";
import AgentConsole from "./AgentConsole";
import ApprovalsView from "./ApprovalsView";
import AuditLedger from "./AuditLedger";
import CatalogueView, { type CatalogueProduct } from "./CatalogueView";
import MCPGuide from "./MCPGuide";
import PolicyEditor from "./PolicyEditor";
import { DecisionBadge, Panel, StatusPill, formatPaise } from "./ui";

type DashboardData = {
  gatewayMode: string;
  demoMode: boolean;
  policy: {
    maxOrderPaise: number;
    dailyCapPaise: number;
    approvalThresholdPaise: number;
    allowedCategories: string[];
    velocityMaxRequests: number;
    velocityWindowSec: number;
    velocityLockoutSec: number;
  };
  spend: { dailySpentPaise: number; dailySpentFormatted: string; dailyCapFormatted: string; usedPercent: number };
  mandate: { status: string; label: string; maxDebitPaise: number; setupLinkUrl: string | null };
  pendingApprovals: number;
  ledger: { length: number; valid: boolean; brokenIndex: number | null; headHash: string };
  decisionCounts: Record<string, number>;
  telemetry: { sampled: number; avgLatencyMs: number; maxLatencyMs: number };
  requests: {
    id: string;
    agentId: string;
    reason: string;
    status: string;
    decision: string | null;
    reasonCode: string | null;
    amountFormatted: string;
    latencyMs: number | null;
    requestedAt: string;
    paymentLinkUrl: string | null;
    orderId: string | null;
  }[];
};

const TABS = [
  { key: "console", label: "🤖 Agent Console" },
  { key: "policy", label: "⚖️ Policy Editor" },
  { key: "catalogue", label: "📦 Catalogue" },
  { key: "approvals", label: "⏳ Approvals" },
  { key: "audit", label: "📜 Audit Ledger" },
  { key: "mcp", label: "🔌 MCP Guide" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function Dashboard({ projectPath }: { projectPath: string }) {
  const [tab, setTab] = useState<TabKey>("console");
  const [data, setData] = useState<DashboardData | null>(null);
  const [products, setProducts] = useState<CatalogueProduct[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [dashboardResponse, catalogueResponse] = await Promise.all([
        fetch("/api/dashboard", { cache: "no-store" }),
        fetch("/api/catalogue", { cache: "no-store" }),
      ]);

      if (!dashboardResponse.ok || !catalogueResponse.ok) {
        throw new Error(
          `Server returned error: Dashboard (${dashboardResponse.status}), Catalogue (${catalogueResponse.status})`,
        );
      }

      const dashData = (await dashboardResponse.json()) as DashboardData;
      const catalogue = (await catalogueResponse.json()) as { products: CatalogueProduct[] };

      setData(dashData);
      setProducts(catalogue.products ?? []);
    } catch (err) {
      console.error("Dashboard refresh error:", err);
      setError(err instanceof Error ? err.message : "Failed to load dashboard data");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function mandateAction(action: "authorize" | "revoke") {
    setBusy(true);
    try {
      await fetch("/api/mandate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function resetSpend() {
    setBusy(true);
    try {
      await fetch("/api/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <main className="mx-auto max-w-7xl px-5 py-10">
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-5 text-red-300">
          <h2 className="text-lg font-bold">Failed to load dashboard</h2>
          <p className="mt-1 text-sm">{error}</p>
          <button className="btn mt-4 bg-red-600 hover:bg-red-500" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-7xl px-5 py-10">
        <p className="text-sm text-slate-400">Loading the control room…</p>
      </main>
    );
  }

  const mandateActive = data.mandate.status === "ACTIVE";

  return (
    <main className="mx-auto max-w-7xl px-5 py-6">
      <header className="glass mb-4 px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🛡️</span>
            <div>
              <h1 className="text-2xl font-bold leading-tight">SpendBoundary</h1>
              <p className="text-xs text-slate-400">
                Policy-gated agentic commerce gateway &amp; execution firewall
              </p>
            </div>
          </div>

          <span className="chip" style={{ color: "#6366F1" }}>
            {data.demoMode ? "Demo Mode" : "Live"} · {data.gatewayMode === "LIVE_TEST_KEYS" ? "Razorpay Test Keys" : "Mock Gateway"}
          </span>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button className="btn" disabled={busy} onClick={resetSpend}>
              Reset Spend (₹0)
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={() => mandateAction(mandateActive ? "revoke" : "authorize")}
            >
              {mandateActive ? "Revoke Mandate" : "Complete ₹1 Setup"}
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="glass px-4 py-3">
            <div className="label">Daily Spent</div>
            <div className="metric mt-1">
              {data.spend.dailySpentFormatted}
              <span className="text-sm font-normal text-slate-400"> / {data.spend.dailyCapFormatted}</span>
            </div>
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${data.spend.usedPercent}%`,
                  background: data.spend.usedPercent > 80 ? "#EF4444" : "#3B82F6",
                }}
              />
            </div>
          </div>

          <div className="glass px-4 py-3">
            <div className="label">Payment Mandate</div>
            <div className="metric mt-1" style={{ color: mandateActive ? "#10B981" : "#F59E0B" }}>
              {data.mandate.label}
            </div>
            <div className="mt-0.5 text-xs text-slate-400">
              {mandateActive
                ? `ACTIVE · ${formatPaise(data.mandate.maxDebitPaise)} per-debit cap`
                : data.mandate.status}
            </div>
          </div>

          <div className="glass px-4 py-3">
            <div className="label">Approvals Queue</div>
            <div
              className={`metric mt-1 ${data.pendingApprovals > 0 ? "animate-pulse-ring" : ""}`}
              style={{ color: data.pendingApprovals > 0 ? "#F59E0B" : undefined }}
            >
              {data.pendingApprovals}
            </div>
            <div className="mt-0.5 text-xs text-slate-400">
              avg latency {data.telemetry.avgLatencyMs} ms
            </div>
          </div>

          <div className="glass px-4 py-3">
            <div className="label">Ledger Integrity</div>
            <div className="metric mt-1" style={{ color: data.ledger.valid ? "#10B981" : "#EF4444" }}>
              {data.ledger.valid ? "Chain Verified ✅" : "Tamper Detected ⚠️"}
            </div>
            <div className="mt-0.5 text-xs text-slate-400">{data.ledger.length} sealed blocks</div>
          </div>
        </div>
      </header>

      {!mandateActive && (
        <div
          className="mb-4 rounded-xl px-4 py-3 text-sm"
          style={{ background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.35)" }}
        >
          <strong className="text-amber-300">No tokenized card mandate. </strong>
          Autonomous zero-OTP debits stay blocked until the one-time ₹1 verification completes.
          {data.mandate.setupLinkUrl && (
            <>
              {" "}
              <a className="font-mono text-amber-300 underline" href={data.mandate.setupLinkUrl} target="_blank" rel="noreferrer">
                {data.mandate.setupLinkUrl}
              </a>
            </>
          )}
        </div>
      )}

      <nav className="glass mb-4 flex flex-wrap gap-1 p-1">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            className="rounded-lg px-3 py-2 text-sm font-medium transition-colors"
            onClick={() => setTab(entry.key)}
            style={
              tab === entry.key
                ? { background: "rgba(59,130,246,0.18)", color: "#F8FAFC" }
                : { color: "#94A3B8" }
            }
          >
            {entry.label}
            {entry.key === "approvals" && data.pendingApprovals > 0 ? ` (${data.pendingApprovals})` : ""}
          </button>
        ))}
      </nav>

      {tab === "console" && <AgentConsole products={products} onMutated={refresh} />}
      {tab === "policy" && <PolicyEditor policy={data.policy} onSaved={refresh} />}
      {tab === "catalogue" && (
        <CatalogueView
          products={products}
          approvalThresholdPaise={data.policy.approvalThresholdPaise}
          maxOrderPaise={data.policy.maxOrderPaise}
        />
      )}
      {tab === "approvals" && <ApprovalsView onMutated={refresh} />}
      {tab === "audit" && <AuditLedger onMutated={refresh} />}
      {tab === "mcp" && <MCPGuide projectPath={projectPath} />}

      <Panel
        className="mt-4"
        title="Recent Agent Requests"
        subtitle="Every cart the firewall has evaluated, newest first."
        right={
          <div className="flex gap-2 text-xs">
            {(["ALLOW", "REVIEW", "DENY"] as const).map((decision) => (
              <span key={decision} className="flex items-center gap-1">
                <DecisionBadge decision={decision} small />
                <span className="font-mono">{data.decisionCounts[decision] ?? 0}</span>
              </span>
            ))}
          </div>
        }
      >
        {data.requests.length === 0 ? (
          <p className="text-sm text-slate-400">No requests yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                  <th className="py-1">Request</th>
                  <th>Amount</th>
                  <th>Decision</th>
                  <th>Status</th>
                  <th>Reason code</th>
                  <th className="text-right">Latency</th>
                </tr>
              </thead>
              <tbody>
                {data.requests.map((request) => (
                  <tr key={request.id} className="border-t" style={{ borderColor: "var(--border)" }}>
                    <td className="py-2">
                      <div className="font-mono text-xs">{request.id}</div>
                      <div className="text-xs text-slate-500">{request.reason.slice(0, 60)}</div>
                    </td>
                    <td className="font-mono">{request.amountFormatted}</td>
                    <td>{request.decision ? <DecisionBadge decision={request.decision} small /> : "—"}</td>
                    <td>
                      <StatusPill status={request.status} />
                    </td>
                    <td className="font-mono text-xs text-slate-400">{request.reasonCode ?? "—"}</td>
                    <td className="text-right font-mono text-xs">
                      {request.latencyMs != null ? `${request.latencyMs} ms` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <footer className="mt-6 pb-8 text-center text-xs text-slate-500">
        SpendBoundary v2.1.0 · integer paise arithmetic · SHA-256 Merkle audit chain · MCP JSON-RPC 2.0
      </footer>
    </main>
  );
}
