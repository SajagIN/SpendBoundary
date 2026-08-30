"use client";

import { useCallback, useEffect, useState } from "react";
import { JsonDrawer, Panel } from "./ui";

type AuditEvent = {
  index: number;
  eventType: string;
  requestId: string | null;
  payload: unknown;
  previousHash: string;
  eventHash: string;
  createdAt: string;
  tampered: boolean;
};

type Verification = {
  valid: boolean;
  length: number;
  brokenIndex: number | null;
  reason: string | null;
  headHash: string;
};

const EVENT_COLOR: Record<string, string> = {
  AGENT_REQUEST: "#6366F1",
  POLICY_DECISION_EVALUATED: "#3B82F6",
  MANDATE_AUTO_DEBIT_CAPTURED: "#10B981",
  PAYMENT_CAPTURED: "#10B981",
  PAYMENT_MANDATE_ACTIVATED: "#10B981",
  APPROVAL_SUBMITTED: "#F59E0B",
  PAYMENT_ATTEMPT_RECORDED: "#F59E0B",
  RETRY_DEDUPLICATED: "#F59E0B",
  TAMPER_DETECTED: "#EF4444",
  POLICY_UPDATED: "#94A3B8",
  SPEND_RESET: "#94A3B8",
};

export default function AuditLedger({ onMutated }: { onMutated: () => void }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/audit", { cache: "no-store" });
    const data = (await response.json()) as { events: AuditEvent[]; verification: Verification };
    setEvents([...data.events].reverse());
    setVerification(data.verification);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: "tamper" | "restore") {
    setBusy(true);
    try {
      await fetch("/api/audit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await load();
      onMutated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Panel
        title="Cryptographic Audit Ledger"
        subtitle="EventHash = SHA-256(previousHash + payloadJson + eventType + createdAt)"
        right={
          <div className="flex gap-2">
            <button className="btn" disabled={busy} onClick={() => act("tamper")}>
              Simulate Tamper
            </button>
            <button className="btn" disabled={busy} onClick={() => act("restore")}>
              Restore
            </button>
          </div>
        }
      >
        {verification && (
          <div
            className="rounded-lg px-4 py-3"
            style={{
              background: verification.valid ? "rgba(16,185,129,0.10)" : "rgba(239,68,68,0.12)",
              border: `1px solid ${verification.valid ? "rgba(16,185,129,0.35)" : "rgba(239,68,68,0.4)"}`,
            }}
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-lg">{verification.valid ? "✅" : "⚠️"}</span>
              <span className="font-semibold" style={{ color: verification.valid ? "#10B981" : "#EF4444" }}>
                {verification.valid ? "Chain Verified" : "TAMPER DETECTED"}
              </span>
              <span className="text-xs text-slate-400">{verification.length} sealed blocks</span>
            </div>
            {verification.reason && (
              <p className="mt-2 text-sm text-rose-200">{verification.reason}</p>
            )}
            <div className="hash mt-2">head: {verification.headHash}</div>
          </div>
        )}

        <div className="mt-4 space-y-2">
          {events.map((event) => (
            <article
              key={event.index}
              className="glass p-3"
              style={
                event.index === verification?.brokenIndex
                  ? { borderColor: "rgba(239,68,68,0.5)", background: "rgba(239,68,68,0.07)" }
                  : undefined
              }
            >
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono text-slate-500">#{String(event.index).padStart(4, "0")}</span>
                <span
                  className="chip"
                  style={{ color: EVENT_COLOR[event.eventType] ?? "#94A3B8" }}
                >
                  {event.eventType}
                </span>
                {event.requestId && <span className="font-mono text-slate-500">{event.requestId}</span>}
                {event.tampered && (
                  <span className="chip" style={{ color: "#EF4444" }}>
                    payload modified
                  </span>
                )}
                <span className="ml-auto text-slate-500">{event.createdAt}</span>
              </div>
              <div className="mt-2 grid gap-1 text-[11px]">
                <div className="hash">prev: {event.previousHash}</div>
                <div className="hash" style={{ color: "#94A3B8" }}>
                  hash: {event.eventHash}
                </div>
              </div>
              <JsonDrawer data={event.payload} label="Sealed payload" />
            </article>
          ))}
          {events.length === 0 && (
            <p className="text-sm text-slate-400">
              The ledger is empty. Run a checkout to seal the first block.
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
}
