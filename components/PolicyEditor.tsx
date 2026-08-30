"use client";

import { useEffect, useState } from "react";
import { Panel, formatPaise } from "./ui";

type PolicyState = {
  maxOrderPaise: number;
  dailyCapPaise: number;
  approvalThresholdPaise: number;
  allowedCategories: string[];
  velocityMaxRequests: number;
  velocityWindowSec: number;
  velocityLockoutSec: number;
};

const KNOWN_CATEGORIES = [
  "Office Supplies",
  "Electronics",
  "Home Office",
  "Furniture",
  "Crypto",
  "Gift Cards",
];

export default function PolicyEditor({
  policy,
  onSaved,
}: {
  policy: PolicyState;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<PolicyState>(policy);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => setDraft(policy), [policy]);

  async function save(patch: Partial<PolicyState>) {
    const next = { ...draft, ...patch };
    setDraft(next);
    setSaving(true);
    try {
      await fetch("/api/policy", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      setSavedAt(new Date().toLocaleTimeString());
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  function toggleCategory(category: string) {
    const allowed = draft.allowedCategories.includes(category)
      ? draft.allowedCategories.filter((entry) => entry !== category)
      : [...draft.allowedCategories, category];
    void save({ allowedCategories: allowed });
  }

  const thresholdInvalid = draft.approvalThresholdPaise > draft.maxOrderPaise;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel
        title="Spend Boundaries"
        subtitle="Written straight to the database; the next agent request uses these numbers."
        right={
          <span className="text-xs text-slate-400">
            {saving ? "Saving…" : savedAt ? `Saved ${savedAt}` : ""}
          </span>
        }
      >
        <Slider
          label="Human-review threshold (Zone 1 → Zone 2)"
          value={draft.approvalThresholdPaise}
          min={10_000}
          max={500_000}
          step={5_000}
          onChange={(value) => setDraft({ ...draft, approvalThresholdPaise: value })}
          onCommit={(value) => save({ approvalThresholdPaise: value })}
        />
        <Slider
          label="Single-order cap (Zone 2 → Zone 3)"
          value={draft.maxOrderPaise}
          min={10_000}
          max={1_000_000}
          step={10_000}
          onChange={(value) => setDraft({ ...draft, maxOrderPaise: value })}
          onCommit={(value) => save({ maxOrderPaise: value })}
        />
        <Slider
          label="24-hour rolling spend cap"
          value={draft.dailyCapPaise}
          min={50_000}
          max={5_000_000}
          step={50_000}
          onChange={(value) => setDraft({ ...draft, dailyCapPaise: value })}
          onCommit={(value) => save({ dailyCapPaise: value })}
        />

        {thresholdInvalid && (
          <p className="mt-2 text-xs text-rose-300">
            The review threshold is above the order cap, so the REVIEW zone is empty — every
            above-threshold cart is denied outright.
          </p>
        )}
      </Panel>

      <div className="space-y-4">
        <Panel title="Category Whitelist" subtitle="Anything outside this list is a hard DENY.">
          <div className="flex flex-wrap gap-2">
            {KNOWN_CATEGORIES.map((category) => {
              const active = draft.allowedCategories.includes(category);
              return (
                <button
                  key={category}
                  className="chip"
                  onClick={() => toggleCategory(category)}
                  style={{
                    background: active ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.08)",
                    color: active ? "#10B981" : "#EF4444",
                    borderColor: active ? "rgba(16,185,129,0.35)" : "rgba(239,68,68,0.3)",
                  }}
                >
                  {active ? "✓" : "✕"} {category}
                </button>
              );
            })}
          </div>
        </Panel>

        <Panel title="Velocity Limiter" subtitle="Rule R-04 — burst cap and circuit breaker.">
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField
              label="Max requests"
              value={draft.velocityMaxRequests}
              onCommit={(value) => save({ velocityMaxRequests: value })}
            />
            <NumberField
              label="Window (seconds)"
              value={draft.velocityWindowSec}
              onCommit={(value) => save({ velocityWindowSec: value })}
            />
            <NumberField
              label="Lockout (seconds)"
              value={draft.velocityLockoutSec}
              onCommit={(value) => save({ velocityLockoutSec: value })}
            />
          </div>
          <p className="mt-3 text-xs text-slate-400">
            Currently {draft.velocityMaxRequests} requests per {draft.velocityWindowSec}s, then a{" "}
            {Math.round(draft.velocityLockoutSec / 60)} minute lockout.
          </p>
        </Panel>

        <Panel title="Resulting Zones">
          <ul className="space-y-2 text-sm">
            <li className="rounded-lg px-3 py-2" style={{ background: "rgba(16,185,129,0.08)" }}>
              <span className="font-semibold text-emerald-400">ALLOW</span> — under{" "}
              {formatPaise(draft.approvalThresholdPaise)}: autonomous zero-OTP debit.
            </li>
            <li className="rounded-lg px-3 py-2" style={{ background: "rgba(245,158,11,0.08)" }}>
              <span className="font-semibold text-amber-400">REVIEW</span> —{" "}
              {formatPaise(draft.approvalThresholdPaise)} to {formatPaise(draft.maxOrderPaise)}:
              hosted payment link, human authorizes.
            </li>
            <li className="rounded-lg px-3 py-2" style={{ background: "rgba(239,68,68,0.08)" }}>
              <span className="font-semibold text-rose-400">DENY</span> — over{" "}
              {formatPaise(draft.maxOrderPaise)}, outside the whitelist, past{" "}
              {formatPaise(draft.dailyCapPaise)} in 24h, or over the velocity limit.
            </li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
}) {
  return (
    <div className="mb-5">
      <div className="flex items-baseline justify-between">
        <span className="label">{label}</span>
        <span className="font-mono text-sm">{formatPaise(value)}</span>
      </div>
      <input
        className="mt-2 w-full"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        onMouseUp={(event) => onCommit(Number((event.target as HTMLInputElement).value))}
        onTouchEnd={(event) => onCommit(Number((event.target as HTMLInputElement).value))}
        onKeyUp={(event) => onCommit(Number((event.target as HTMLInputElement).value))}
      />
      <div className="mt-1 flex justify-between text-[11px] text-slate-500">
        <span>{formatPaise(min)}</span>
        <span>{value} paise</span>
        <span>{formatPaise(max)}</span>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [local, setLocal] = useState(String(value));
  useEffect(() => setLocal(String(value)), [value]);
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input
        className="input mt-1"
        type="number"
        min={1}
        value={local}
        onChange={(event) => setLocal(event.target.value)}
        onBlur={() => {
          const parsed = Number(local);
          if (Number.isInteger(parsed) && parsed > 0) onCommit(parsed);
          else setLocal(String(value));
        }}
      />
    </label>
  );
}
