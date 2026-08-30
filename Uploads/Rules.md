# Operating Rules & Policy Guardrails: SpendBoundary

This document specifies the immutable business logic, financial boundaries, and security constraints enforced across the SpendBoundary gateway.

---

## 1. Core Financial Rules & Thresholds

### Rule R-01: Integer Paise Currency Standard
- All monetary calculations and database columns must use non-negative integer paise ($1\text{ INR} = 100\text{ paise}$).
- Floating-point calculations are strictly prohibited in the policy engine and payment gateway adapters.

### Rule R-02: 3-Zone Threshold Architecture
1. **Zone 1: Autonomous Auto-Debit (`ALLOW` - Under Merchant Threshold)**
   - Triggered when: $\text{Requested Amount} < \text{Approval Threshold}$ (Default: $< 100,000\text{ paise} / \text{₹}1,000$) and all category/velocity rules pass.
   - Execution: Auto-debits pre-authorized card mandate (`RuPay / Visa •••• 1005`) without human OTP or external tab redirection.
   - Target Latency: $< 1,000\text{ms}$.
2. **Zone 2: Human Review Dual-Control (`REVIEW` - Above Threshold)**
   - Triggered when: $\text{Approval Threshold} \le \text{Requested Amount} \le \text{Max Order Cap}$ (Default: $\text{₹}1,000 – \text{₹}2,000$).
   - Execution: Halts autonomous execution, generates dynamic Razorpay Hosted Payment Link (`rzp.io/...`), and awaits human OTP authorization.
3. **Zone 3: Hard Policy Veto (`DENY` - Boundary Violations)**
   - Triggered when:
     - $\text{Requested Amount} > \text{Max Order Cap}$ (Default: $> 200,000\text{ paise} / \text{₹}2,000$)
     - Cumulative 24-hour spend exceeds daily limit (Default: $> 500,000\text{ paise} / \text{₹}5,000$)
     - Cart contains non-whitelisted product categories
     - Velocity rate limit exceeded ($> 3\text{ requests / } 60\text{s}$)
   - Execution: Immediate rejection, zero payment link generation, audit event logged.

---

## 2. Anti-Hallucination & Circuit Breaker Rules

### Rule R-03: Anti-Runaway Retry Quarantining
- If a debit operation encounters a network error, gateway timeout, or ambiguous upstream status, the request transitions to `DEBIT_IN_PROGRESS`.
- Any subsequent debit requests with the same cart or idempotency key are **BLOCKED** and quarantined.
- The AI agent receives a structured status code (`QUARANTINED_PENDING_RECONCILIATION`) instructing it to wait rather than re-triggering payments.

### Rule R-04: Velocity Burst Limiter & Circuit Breaker
- An AI agent is permitted a maximum of **3 checkout evaluations per 60-second window**.
- If a 4th request arrives within the window, the policy engine activates a **15-minute circuit breaker lock**, denying all transactions for that agent with reason `VELOCITY_LIMIT_EXCEEDED`.

---

## 3. Consolidated Consent & Tokenized Mandate Rules

### Rule R-05: One-Time ₹1 Mandate Verification
- To enable autonomous commerce, the user authorizes SpendBoundary once via a ₹1 setup verification link.
- The gateway extracts and persists:
  - `cardNetwork` (Visa, Mastercard, RuPay)
  - `cardLast4` (e.g. `1005`)
  - `tokenId` (Razorpay payment token reference)
  - `maxDebitPaise` (Hard limit per single debit: default 100,000 paise / ₹1,000)
- Mandate state must be `ACTIVE` before any zero-OTP autonomous checkouts are permitted.

---

## 4. Cryptographic Audit Rules

### Rule R-06: Append-Only Merkle Hash Chain
- Every state change appends an immutable record to `AuditEvent`:
  $$\text{EventHash} = \text{SHA-256}(\text{PreviousHash} + \text{PayloadJson} + \text{EventType} + \text{CreatedAt})$$
- The genesis event hash is defined as 64 zeros: `"0000000000000000000000000000000000000000000000000000000000000000"`.
- Chain verification is performed automatically on every dashboard audit log fetch.
