# Product Requirements Document (PRD): SpendBoundary

**Version:** 2.1.0  
**Project:** SpendBoundary — Policy-Gated Agentic Commerce Gateway & Execution Firewall  
**Target Platform:** Model Context Protocol (MCP) + Claude Desktop + ChatGPT Custom GPT Actions + Next.js App Router  
**Database Targets:** Local SQLite (Development) / Supabase PostgreSQL with Connection Pooling (Production)

---

## 1. Problem Statement & Core Mission

Autonomous AI agents (Claude, ChatGPT, AutoGPT) are rapidly evolving from discovery and recommendation tools into transaction-executing commerce agents. However, giving an LLM direct, unconstrained access to a merchant's payment API introduces catastrophic risks:
1. **Unbounded Financial Liability:** An AI agent hallucinating or caught in a prompt-injection loop can rapidly drain a user's bank account or corporate credit line.
2. **Payment Failure Loop Hallucination:** If a network timeout occurs during debit, the AI may assume the payment failed and continuously trigger duplicate charges.
3. **Repetitive OTP Friction:** Traditional payment gateways require a user OTP for every micro-transaction (e.g. ₹50 items), completely destroying the autonomous conversational experience.

**SpendBoundary solves this by introducing a deterministic, policy-gated execution firewall, consolidated consent tokenization, anti-hallucination circuit breakers, and a SHA-256 Merkle audit blockchain.**

---

## 2. Core Functional Requirements & 3-Zone Threshold Architecture

SpendBoundary implements a strict **3-Zone Financial Boundary System** configured by the merchant:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SPENDBOUNDARY 3-ZONE ENGINE                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  Zone 1: ALLOW (< ₹1,000)                                                  │
│  • Autonomous Zero-OTP checkout using tokenized pre-authorized mandate      │
│  • Executes at the "speed of intent" (< 1s) inside the AI chat interface    │
│  • Zero popups, zero redirect tabs, zero user OTP prompts                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  Zone 2: REVIEW (₹1,000 – ₹2,000)                                           │
│  • Autonomous execution HALTED; triggers dual-control human review          │
│  • Generates secure Razorpay Hosted Payment Link (rzp.io/...)               │
│  • User completes explicit authorization (2FA/OTP/PIN) via payment link     │
├─────────────────────────────────────────────────────────────────────────────┤
│  Zone 3: DENY (> ₹2,000 or Unapproved Category / Velocity Spike)            │
│  • Hard execution veto; immediately aborts checkout                         │
│  • Prevents AI retry loops and records violation to audit ledger            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### F1: Consolidated Consent & ₹1 Mandate Setup
- Users perform a **one-time consent authorization** by paying a ₹1 verification fee via a hosted Razorpay link.
- SpendBoundary extracts the authorized card token, card network (Visa, Mastercard, RuPay), and customer ID, activating a `PaymentMandate` record with an explicit maximum debit cap (`maxDebitPaise = 100000`).

### F2: Autonomous Sub-Limit Debits (< ₹1,000)
- When an AI agent submits a cart whose server-recalculated sum is below the merchant's approval threshold (`< ₹1,000`) and within category rules:
  - SpendBoundary approves the request (`decision: "ALLOW"`).
  - Automatically executes the transaction against the stored tokenized mandate.
  - Creates a genuine Razorpay Order (`order_...`) and transitions order status to `PAID`.
  - Returns direct confirmation to the AI agent **without opening external tabs or prompting for OTP**.

### F3: Human Review & Hosted Payment Links (> ₹1,000)
- Purchases exceeding the threshold (`₹1,000 – ₹2,000`) transition to `REVIEW`.
- SpendBoundary halts autonomous debit and creates a live Razorpay Payment Link (`plink_...`).
- The AI agent returns the hosted payment link to the user in chat for human verification.
- Active background reconciliation polls Razorpay API (`fetchPaymentLink`) to verify capture and update order status to `PAID` upon user completion.

### F4: Anti-Hallucination Failsafes & Runaway Retry Protection
- **Idempotency Quarantining:** Every checkout request generates a deterministic SHA-256 idempotency key based on `agentId + cartSnapshot + epochTimestamp`.
- **Phantom Debit Lock (`DEBIT_IN_PROGRESS`):** If a network timeout or transient error occurs while debiting Razorpay, the order is locked into a quarantined state. The AI agent is forbidden from submitting duplicate debits for the same cart until status reconciliation completes.
- **Velocity Burst Limiter:** Maximum 3 transactions per 60 seconds per agent. Attempting a 4th request within the window triggers an automatic 15-minute circuit breaker lock (`DENY: RATE_LIMIT_EXCEEDED`).

### F5: Millisecond-Precision Time & Latency Tracking
- Every request and decision records:
  - `requestedAt`: Initial timestamp when AI submitted the cart.
  - `evaluatedAt`: Timestamp when policy engine completed rule verification.
  - `debitedAt`: Timestamp when gateway confirmed payment execution.
  - `latencyMs`: Total end-to-end execution latency in milliseconds.
  - `epochTimestamp`: Unix epoch millisecond counter stored for immutable audit ordering.

### F6: Cryptographic SHA-256 Merkle Audit Blockchain
- Every action (`AGENT_REQUEST`, `POLICY_DECISION`, `APPROVAL_SUBMITTED`, `PAYMENT_CAPTURED`, `RETRY_DEDUPLICATED`, `TAMPER_DETECTED`) is immutably appended to a cryptographic hash chain:
  $$\text{EventHash} = \text{SHA-256}(\text{PreviousHash} + \text{PayloadJson} + \text{EventType} + \text{CreatedAt})$$
- Built-in verification engine validates the complete chain integrity on every dashboard load.

---

## 3. Technical Architecture & Data Layer

### Model Context Protocol (MCP) Interface
SpendBoundary exposes an open MCP server over JSON-RPC 2.0 with the following tools:
1. `search_catalogue(query)`: Search products with live stock and integer paise pricing.
2. `get_policy_limits()`: Fetch current spend limits, allowed categories, and mandate status.
3. `request_checkout(items, reason)`: Submit cart for deterministic policy evaluation and payment execution.
4. `check_approval_status(requestId)`: Poll status of pending reviews and reconcile Razorpay payments in real-time.

### Database Target Strategy
- **Local Development:** SQLite (`DATABASE_URL="file:./dev.db"`) with zero external network dependencies.
- **Cloud / Production:** Supabase PostgreSQL with Transaction Pooling (`aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true`) and Direct Connection URL for migrations.

---

## 4. Acceptance Criteria & Validation Matrix

| Test ID | Scenario | Expected Outcome | Verification |
|---|---|---|---|
| **AC-01** | AI buys Notebook (₹350) with Active Mandate | Evaluates to `ALLOW`, debits token silently, logs Razorpay order, returns success with 0 OTP prompts. | Passed ✅ |
| **AC-02** | AI buys Smart Lamp (₹1,500) | Evaluates to `REVIEW`, halts debit, generates Razorpay Payment Link (`rzp.io/...`), awaits human OTP. | Passed ✅ |
| **AC-03** | AI buys Crypto Miner (₹5,000) | Evaluates to `DENY` due to disallowed category and order cap violation (> ₹2,000). | Passed ✅ |
| **AC-04** | AI submits 4 orders in 30 seconds | First 3 evaluate; 4th triggers velocity burst limit and halts agent. | Passed ✅ |
| **AC-05** | Network timeout during debit | Order quarantined as `DEBIT_IN_PROGRESS`; duplicate agent checkout blocked. | Passed ✅ |
| **AC-06** | Merkle Audit Chain Integrity | Modifying any database row causes chain validation to report `TAMPER_DETECTED`. | Passed ✅ |
