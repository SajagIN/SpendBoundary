# SpendBoundary: Comprehensive Incident & Error Post-Mortem Log

This document serves as an exhaustive, unfiltered engineering record of every single error, architectural failure, type mismatch, runtime bottleneck, and security anomaly encountered during the development of the **SpendBoundary** Autonomous AI Payment Gateway & Execution Firewall.

---

## Table of Incidents

| # | Error Category | Root Cause | Impact | Resolution | Status |
|---|---|---|---|---|---|
| **E01** | Database Constraint Violation | `P2002: Unique constraint failed on the fields: (id)` | Checkout route failed with 500 when reusing client-generated request IDs. | Replaced client ID generation with cryptographically random `req_${Date.now()}_${randomBytes(4).toString('hex')}` and upsert semantics. | **RESOLVED** |
| **E02** | TypeScript Type Desynchronization | `Property 'paymentMandate' does not exist on type 'PrismaClient'` | TypeScript language server and IDE reported red squiggles after schema expansion. | Added explicit `CustomPrismaClient` type definition extension in `lib/prisma.ts` and ran clean `npx prisma generate`. | **RESOLVED** |
| **E03** | Windows OS File Locking | `EPERM: operation not permitted, rename query_engine-windows.dll.node` | Prisma CLI failed to regenerate client while Next.js dev server held active DLL file locks. | Killed background node worker (`Stop-Process -Force`), generated client, and restarted Next.js with `--skip-generate` for db push. | **RESOLVED** |
| **E04** | Protocol Schema Mismatch | `P1012: the URL must start with the protocol postgresql:// or postgres://` | Prisma crashed during startup when `provider = "postgresql"` was paired with `DATABASE_URL="file:./dev.db"`. | Standardized environment configurations and synchronized `schema.prisma` datasource provider with active environment variables. | **RESOLVED** |
| **E05** | Supabase Direct IPv6 Resolution Failure | `WARNING: Name resolution of db.[project-ref].supabase.co failed (P1001)` | Direct Supabase database host is IPv6-only on standard consumer ISPs, dropping connections on port 5432. | Migrated to Supabase IPv4 Transaction Pooler: `aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true` with `DIRECT_URL` pooling. | **RESOLVED** |
| **E06** | Git Merge Conflict Markers in Schema | `<<<<<<< HEAD / >>>>>>> parent of 9a2b2fc` in `prisma/schema.prisma` | Prisma parser failed to parse corrupted schema file after upstream pull request merge. | Cleaned corrupted merge markers and restored canonical schema definition with all 8 database models. | **RESOLVED** |
| **E07** | ChatGPT Custom GPT Action Failure | *"I couldn't reach the SpendBoundary merchant service right now"* | Cloudflare quick tunnel URLs rotate on restart, and ChatGPT retains cached URLs in existing active chat sessions. | Created static `public/openapi.json`, updated tunnel endpoints, and documented requirement to open a fresh "New Chat" after GPT action edits. | **RESOLVED** |
| **E08** | Silent Simulated Checkout / Dashboard Discrepancy | AI chatbot claimed order was paid, but zero transactions appeared in Razorpay merchant dashboard. | Checkout code fell back to mock simulation when pre-authorized token wasn't tied to a live customer ID. | Implemented active Razorpay API polling (`fetchPaymentLink`, `fetchPayment`), extracting genuine card network and token IDs for real Razorpay Order creation. | **RESOLVED** |
| **E09** | ₹1 Pre-Auth Verification Deadlock | Dashboard displayed `NO_CARD_STORED` even after user completed ₹1 setup payment in Razorpay. | Webhooks were not exposed locally without active tunnel forwarding, leaving database mandate in `PENDING_AUTHORIZATION`. | Added active real-time reconciliation to `getOrCreateMandateSetupLink` and `check_approval_status` to auto-fetch payment details directly from Razorpay API. | **RESOLVED** |
| **E10** | Runaway AI Retry Loop & Hallucination Risk | AI model hallucinates payment failure on network timeout and re-executes payment multiple times, causing duplicate debits. | Account could be drained if payment gateway succeeds but AI agent receives a delayed response. | Engineered **Circuit Breakers**, **Idempotency Quarantines**, and **Hard Velocity Rate Limiters** with strict per-minute spend fences. | **RESOLVED** |

---

## Detailed Technical Post-Mortems

### Incident E01: Database Unique Constraint Violation (`P2002`)
- **Symptom:** When an agent re-submitted a checkout or retried a request, `app/api/checkout/route.ts` threw `Error [PrismaClientKnownRequestError]: Unique constraint failed on the fields: (id)`.
- **Root Cause:** The client submitted a deterministic `requestId` (e.g. `req_retry_...`), and the server executed `prisma.agentRequest.create({ data: { id: requestId } })` without checking for existence.
- **Fix:** 
  1. Updated ID generation to guaranteed cryptographic uniqueness: `req_${Date.now()}_${randomBytes(4).toString('hex')}`.
  2. Implemented `prisma.agentRequest.upsert` and structured error handling for duplicate requests.

---

### Incident E02: Prisma TypeScript Client Desynchronization
- **Symptom:** TypeScript compilation failed with `Property 'paymentMandate' does not exist on type 'PrismaClient'`.
- **Root Cause:** The IDE language server cached the old Prisma Client AST in memory before `npx prisma generate` was executed following the addition of `model PaymentMandate`.
- **Fix:**
  1. Created an explicit typing wrapper in `lib/prisma.ts`:
     ```typescript
     export type CustomPrismaClient = PrismaClient & {
       paymentMandate: any;
     };
     ```
  2. Verified clean compilation with `npx tsc --noEmit`.

---

### Incident E03: Windows Engine File Lock (`EPERM`)
- **Symptom:** `EPERM: operation not permitted, rename '...\query_engine-windows.dll.node.tmp...' -> '...\query_engine-windows.dll.node'`.
- **Root Cause:** On Windows, the running Next.js Node process keeps the query engine binary locked in memory, preventing `prisma generate` from overwriting the file.
- **Fix:**
  1. Created automated execution scripts that terminate background Node processes prior to code generation.
  2. Instructed developers to use `npx prisma db push --skip-generate` when modifying schema during active development.

---

### Incident E04 & E05: Database Protocol & IPv6 Supabase Resolution
- **Symptom:** 
  1. `error: Error validating datasource 'db': the URL must start with the protocol 'postgresql://' or 'postgres://'`.
  2. `WARNING: Name resolution of db.[ref].supabase.co failed (P1001: Can't reach database server)`.
- **Root Cause:**
  1. Setting `provider = "postgresql"` while `DATABASE_URL` pointed to SQLite `file:./dev.db`.
  2. Modern Supabase direct database hostnames (`db.xxx.supabase.co`) resolve exclusively to IPv6 addresses, which fail on standard consumer IPv4 networks.
- **Fix:**
  1. Configured Supabase connection pooler via IPv4 endpoints:
     ```env
     DATABASE_URL="postgresql://postgres.[ref]:[PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
     DIRECT_URL="postgresql://postgres.[ref]:[PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres"
     ```
  2. Implemented seamless fallback to local SQLite (`DATABASE_URL="file:./dev.db"`) for offline development.

---

### Incident E07: ChatGPT Custom GPT OpenAPI Caching & Deadlock
- **Symptom:** ChatGPT reported: *"I couldn't reach the SpendBoundary merchant service right now, so I wasn't able to search the notebook catalogue or place the purchase."*
- **Root Cause:**
  1. Cloudflare quick tunnel URLs change when restarted.
  2. ChatGPT Custom GPT caches the OpenAPI schema per chat thread; updating the Action in GPT configuration does not invalidate existing open chat sessions.
- **Fix:**
  1. Hosted OpenAPI 3.1.0 schema at `/openapi.json` for direct dynamic import.
  2. Established operational rule: Whenever the tunnel URL changes, the developer must update the GPT Action and **open a brand-new chat session** to clear ChatGPT's connection cache.

---

### Incident E08 & E09: Mandate Reconciliation & Zero-OTP Execution
- **Symptom:**
  1. User authorized ₹1 setup payment, but SpendBoundary still showed `NO_CARD_STORED`.
  2. Agent reported successful checkout in conversation, but no payment record existed in Razorpay dashboard.
- **Root Cause:**
  1. Local development environments cannot receive external Razorpay webhooks without manual reverse tunneling.
  2. The checkout flow did not actively verify whether the stored card reference was an active, debitable token.
- **Fix:**
  1. Implemented active polling via Razorpay REST API (`fetchPaymentLink`, `fetchPayment`) directly inside `getOrCreateMandateSetupLink` and `check_approval_status`.
  2. Integrated Razorpay Orders API (`razorpayGateway.createOrder`) during sub-limit autonomous debits to guarantee that genuine Razorpay Order IDs (`order_...`) are logged on the merchant dashboard without requiring user OTP.

---

### Incident E10: Anti-Hallucination Failsafe & Circuit Breaker Architecture
- **Problem Statement:** In conversational AI commerce, if a network timeout occurs during payment debit, the LLM might hallucinate that the payment failed and repeatedly issue new debit requests, draining the customer's funds.
- **Engineered Security Solution:**
  1. **Idempotency Quarantining:** Every cart hash and checkout intent is locked with a unique SHA-256 idempotency key.
  2. **Pending Debit Quarantine State:** If a debit attempt does not receive an immediate confirmation, the request transitions to `DEBIT_IN_PROGRESS`. Any duplicate agent requests for the same cart return `STATUS_CHECK_REQUIRED` instead of executing a new charge.
  3. **Velocity Burst Limiters:** Strict cap of 3 transactions per 60 seconds. Exceeding this rate triggers an automatic 15-minute circuit-breaker lock on the AI agent.
