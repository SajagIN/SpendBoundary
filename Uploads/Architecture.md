# System Architecture: SpendBoundary

**System Classification:** Policy-Gated Agentic Commerce Gateway & Execution Firewall  
**Protocol:** Model Context Protocol (MCP) JSON-RPC 2.0 / OpenAPI 3.1.0  
**Stack:** Next.js 15 App Router + TypeScript + TailwindCSS + Prisma ORM (SQLite / Supabase PostgreSQL) + Razorpay API  

---

## 1. High-Level System Architecture

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                            AUTONOMOUS AGENT LAYER                           │
│     Claude Desktop (via stdio MCP)  │  ChatGPT Custom GPT (OpenAPI REST)    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ JSON-RPC 2.0 / REST
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SPENDBOUNDARY GATEWAY & FIREWALL                    │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ 1. Deterministic Cart & Price Verification                            │  │
│  │    • Re-queries database product inventory for prices in integer paise│  │
│  │    • Total = Σ (db_price_paise × qty); rejects LLM hallucinated sums  │  │
│  └───────────────────────────────────┬───────────────────────────────────┘  │
│                                      ▼                                      │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ 2. Deterministic Policy Rule Engine                                   │  │
│  │    • Rule 1: Single-Order Cap (Max ₹2,000 / 200,000 paise)           │  │
│  │    • Rule 2: 24-Hour Rolling Spend Cap (Max ₹5,000 / 500,000 paise)   │  │
│  │    • Rule 3: Category Whitelist Enforcement                           │  │
│  │    • Rule 4: Velocity Burst Rate Limiting (Max 3 reqs / 60 seconds)   │  │
│  │    • Rule 5: Dynamic Approval Threshold (₹1,000 / 100,000 paise)      │  │
│  └───────────────────────────────────┬───────────────────────────────────┘  │
│                                      ▼                                      │
│         ┌────────────────────────────┴────────────────────────────┐         │
│         │ Decision Branching Matrix                               │         │
│         ├────────────────────────────┬────────────────────────────┤         │
│         ▼                            ▼                            ▼         │
│     [ ALLOW ]                    [ REVIEW ]                    [ DENY ]     │
│   (< ₹1,000)                   (₹1,000 - ₹2,000)             (Violations)   │
│  Auto-Debit Stored Mandate   Generate Razorpay Hosted Link  Immediate Veto  │
│  Zero OTP / In-Context       Human-in-the-loop OTP/2FA      Halt AI Agent   │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ 3. Anti-Hallucination Failsafe & Idempotency Quarantine               │  │
│  │    • Unique deterministic SHA-256 idempotency key per cart            │  │
│  │    • Transient timeout lock: order set to DEBIT_IN_PROGRESS           │  │
│  │    • Prevents AI runaway retry loops and duplicate debit calls        │  │
│  └───────────────────────────────────┬───────────────────────────────────┘  │
│                                      ▼                                      │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ 4. Cryptographic SHA-256 Merkle Audit Blockchain Engine               │  │
│  │    • SHA256(prevHash + payloadJson + eventType + createdAt)           │  │
│  │    • Immutable event ledger with real-time tamper detection           │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                     ▼
      ┌───────────────────────────┐         ┌───────────────────────────┐
      │   DATABASE STORAGE LAYER  │         │    RAZORPAY CORE ENGINE   │
      │ • SQLite (Local dev.db)   │         │ • Orders API (order_...)  │
      │ • Supabase PostgreSQL     │         │ • Payment Links (plink_)  │
      │   (Transaction Pooler)    │         │ • Tokenized Card Mandates │
      └───────────────────────────┘         └───────────────────────────┘
```

---

## 2. Decision State Machine & Anti-Hallucination Lifecycle

```text
       [ AI Agent Cart Submission ]
                   │
                   ▼
       [ Deterministic Evaluation ]
                   │
       ┌───────────┼───────────┐
       ▼           ▼           ▼
   [ ALLOW ]   [ REVIEW ]   [ DENY ]
       │           │           │
       │           │           └──► [ Order REJECTED ] ──► [ Merkle Audit Event ]
       │           │
       │           └──► [ Razorpay Payment Link Created ]
       │                         │
       │                         ├──► [ User Completes OTP ] ──► [ Order PAID ]
       │                         └──► [ Expired / Cancelled ] ──► [ Order EXPIRED ]
       │
       ▼
[ Tokenized Auto-Debit Attempt ]
       │
       ├──► [ Success ] ──► [ Order PAID (< 1s, Zero OTP) ] ──► [ Merkle Audit Event ]
       │
       └──► [ Timeout / Ambiguous Gateway Status ]
                   │
                   ▼
       [ State: DEBIT_IN_PROGRESS (Quarantined) ]
                   │
                   ├──► Duplicate AI Retries BLOCKED (Returns QUARANTINE_LOCKED)
                   └──► Active Background Reconciliation confirms status with Razorpay
```

---

## 3. Financial Threshold System Specifications

| Boundary Level | Amount Range | Action | User Interaction | Verification Method |
|---|---|---|---|---|
| **Autonomous Zone** | ₹0.01 – ₹999.99 | `ALLOW` | **Zero OTP / In-Context** | Stored Token Mandate (`RuPay / Visa •••• 1005`) |
| **Human Review Zone** | ₹1,000.00 – ₹2,000.00 | `REVIEW` | **Human-in-the-Loop** | Razorpay Hosted Payment Link (`rzp.io/...`) with OTP |
| **Hard Policy Veto** | > ₹2,000.00 | `DENY` | **Execution Blocked** | Policy Engine Hard Cap Rejection |
| **Category Veto** | Any Amount | `DENY` | **Execution Blocked** | Category Whitelist Rule |
| **Velocity Limiter** | > 3 orders / 60s | `DENY` | **Execution Blocked** | Velocity Burst Rule (15 min cooling lock) |

---

## 4. Latency & Telemetry Metrics

Every execution cycle captures high-precision timestamp metrics:
```typescript
interface ExecutionTelemetry {
  requestId: string;
  requestedAt: string;        // ISO 8601 string
  evaluatedAt: string;        // ISO 8601 string
  debitedAt?: string;         // ISO 8601 string
  latencyMs: number;          // Total round-trip milliseconds (< 800ms)
  epochTimestamp: number;     // Millisecond timestamp for monotonic ordering
}
```

---

## 5. Security & Trust Boundaries

1. **LLM Untrusted Boundary:** Any data generated by an AI model (item prices, totals, authorization codes) is strictly treated as untrusted input. The server reconstructs the cart from database source-of-truth.
2. **Deterministic Financial Math:** Zero floating-point arithmetic. All sums, limits, discounts, and debits are calculated using 64-bit integer paise ($1\text{ INR} = 100\text{ paise}$).
3. **Double-Spend & Replay Defense:** SHA-256 idempotency locks combined with transactional database write barriers prevent duplicate execution even under extreme network jitter.
4. **Cryptographic Tamper-Proof Audit:** Modifying any historical database row invalidates the SHA-256 Merkle chain, alerting administrators immediately in the dashboard.
