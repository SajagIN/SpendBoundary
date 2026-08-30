"use client";

import { useCallback, useEffect, useState } from "react";
import { Panel, StatusPill, formatPaise } from "./ui";

type Approval = {
  requestId: string;
  status: string;
  amountPaise: number;
  amountFormatted: string;
  paymentLinkUrl: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  agentId: string;
  reason: string;
  items: { name: string; quantity: number; lineTotalPaise: number }[];
  reasonCode: string | null;
  reasonText: string | null;
};

export default function ApprovalsView({ onMutated }: { onMutated: () => void }) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/approvals", { cache: "no-store" });
    const data = (await response.json()) as { approvals: Approval[] };
    setApprovals(data.approvals);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(requestId: string, action: "approve" | "reject") {
    setBusyId(requestId);
    try {
      await fetch("/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, action }),
      });
      await load();
      onMutated();
    } finally {
      setBusyId(null);
    }
  }

  const pending = approvals.filter((approval) => approval.status === "PENDING");
  const settled = approvals.filter((approval) => approval.status !== "PENDING");

  return (
    <div className="space-y-4">
      <Panel
        title="Human Review Queue"
        subtitle="Zone 2 transactions. The agent is halted until a human decides."
        right={
          <span className="chip" style={{ color: "#F59E0B" }}>
            {pending.length} pending
          </span>
        }
      >
        {pending.length === 0 ? (
          <p className="text-sm text-slate-400">
            Nothing waiting. Run the ₹1,500 desk lamp scenario in the Agent Console to create one.
          </p>
        ) : (
          <div className="space-y-3">
            {pending.map((approval) => (
              <article
                key={approval.requestId}
                className="glass p-4"
                style={{ borderColor: "rgba(245,158,11,0.3)" }}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="metric">{approval.amountFormatted}</div>
                    <div className="hash">{approval.requestId}</div>
                  </div>
                  <span className="chip" style={{ color: "#F59E0B" }}>
                    {approval.reasonCode ?? "APPROVAL_THRESHOLD_TRIGGERED"}
                  </span>
                </div>

                <p className="mt-3 text-sm text-slate-300">
                  <span className="label">Agent reason </span>
                  {approval.reason}
                </p>

                <ul className="mt-2 space-y-1 text-xs text-slate-400">
                  {approval.items.map((item, index) => (
                    <li key={index} className="font-mono">
                      {item.quantity} × {item.name} — {formatPaise(item.lineTotalPaise)}
                    </li>
                  ))}
                </ul>

                {approval.paymentLinkUrl && (
                  <a
                    className="mt-3 block font-mono text-xs text-amber-300 underline"
                    href={approval.paymentLinkUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {approval.paymentLinkUrl}
                  </a>
                )}

                <div className="mt-4 flex gap-2">
                  <button
                    className="btn"
                    style={{ background: "rgba(16,185,129,0.16)", borderColor: "rgba(16,185,129,0.4)" }}
                    disabled={busyId === approval.requestId}
                    onClick={() => decide(approval.requestId, "approve")}
                  >
                    Approve &amp; Execute
                  </button>
                  <button
                    className="btn"
                    style={{ background: "rgba(239,68,68,0.14)", borderColor: "rgba(239,68,68,0.4)" }}
                    disabled={busyId === approval.requestId}
                    onClick={() => decide(approval.requestId, "reject")}
                  >
                    Reject
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Settled Reviews" subtitle="Approved, rejected and expired links.">
        {settled.length === 0 ? (
          <p className="text-sm text-slate-400">No settled reviews yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                <th className="py-1">Request</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Decided by</th>
                <th>Decided at</th>
              </tr>
            </thead>
            <tbody>
              {settled.map((approval) => (
                <tr key={approval.requestId} className="border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="py-2 font-mono text-xs">{approval.requestId}</td>
                  <td className="font-mono">{approval.amountFormatted}</td>
                  <td>
                    <StatusPill status={approval.status} />
                  </td>
                  <td className="text-slate-400">{approval.decidedBy ?? "—"}</td>
                  <td className="text-xs text-slate-400">
                    {approval.decidedAt ? new Date(approval.decidedAt).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
