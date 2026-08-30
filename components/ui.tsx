"use client";

import type { ReactNode } from "react";

export const DECISION_STYLE: Record<string, { bg: string; text: string; border: string; label: string }> = {
  ALLOW: {
    bg: "rgba(16,185,129,0.12)",
    text: "#10B981",
    border: "rgba(16,185,129,0.35)",
    label: "ALLOW",
  },
  REVIEW: {
    bg: "rgba(245,158,11,0.12)",
    text: "#F59E0B",
    border: "rgba(245,158,11,0.35)",
    label: "REVIEW",
  },
  DENY: {
    bg: "rgba(239,68,68,0.12)",
    text: "#EF4444",
    border: "rgba(239,68,68,0.35)",
    label: "DENY",
  },
  MCP: {
    bg: "rgba(99,102,241,0.12)",
    text: "#6366F1",
    border: "rgba(99,102,241,0.35)",
    label: "MCP",
  },
};

export function DecisionBadge({ decision, small }: { decision: string; small?: boolean }) {
  const style = DECISION_STYLE[decision] ?? DECISION_STYLE.MCP;
  return (
    <span
      className={`inline-flex items-center rounded-md font-bold tracking-wide ${
        small ? "px-2 py-0.5 text-[11px]" : "px-3 py-1 text-sm"
      }`}
      style={{ background: style.bg, color: style.text, border: `1px solid ${style.border}` }}
    >
      {decision}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    PAID: "ALLOW",
    SIMULATED_NOT_CHARGED: "DENY",
    SIMULATED: "DENY",
    AWAITING_PAYMENT: "REVIEW",
    MANDATE_UNUSABLE: "DENY",
    AWAITING_HUMAN_APPROVAL: "REVIEW",
    AWAITING_APPROVAL: "REVIEW",
    PENDING: "REVIEW",
    MANDATE_REQUIRED: "REVIEW",
    DEBIT_IN_PROGRESS: "REVIEW",
    QUARANTINED_PENDING_RECONCILIATION: "REVIEW",
    RETRY_DEDUPLICATED: "MCP",
    BLOCKED: "DENY",
    REJECTED: "DENY",
    EXPIRED: "DENY",
    CANCELLED: "DENY",
    APPROVED: "ALLOW",
  };
  const style = DECISION_STYLE[map[status] ?? "MCP"];
  return (
    <span
      className="inline-flex items-center rounded-md px-2 py-0.5 font-mono text-[11px]"
      style={{ background: style.bg, color: style.text, border: `1px solid ${style.border}` }}
    >
      {status}
    </span>
  );
}

export function Panel({
  title,
  subtitle,
  right,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || right) && (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-lg font-semibold">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent?: string;
}) {
  return (
    <div className="glass px-4 py-3">
      <div className="label">{label}</div>
      <div className="metric mt-1" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

export function JsonDrawer({ data, label = "Raw JSON" }: { data: unknown; label?: string }) {
  return (
    <details className="mt-3 rounded-lg border" style={{ borderColor: "var(--border)" }}>
      <summary className="cursor-pointer select-none px-3 py-2 text-xs text-slate-300">{label}</summary>
      <pre className="max-h-72 overflow-auto px-3 pb-3 font-mono text-[11px] leading-relaxed text-slate-300">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

export function formatPaise(paise: number): string {
  const negative = paise < 0;
  const absolute = Math.abs(Math.trunc(paise));
  const rupees = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  const digits = String(rupees);
  const grouped =
    digits.length <= 3
      ? digits
      : `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${digits.slice(-3)}`;
  return `${negative ? "-" : ""}₹${grouped}.${String(remainder).padStart(2, "0")}`;
}
