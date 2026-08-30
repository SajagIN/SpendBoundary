# Project Roadmap & Implementation Phases: SpendBoundary

This roadmap outlines the complete lifecycle of SpendBoundary, from initial prototype to production-grade agentic financial infrastructure.

---

## Phase 1: Core Architecture & Deterministic Engine (COMPLETED ✅)
- [x] **Prisma Database Schema:** `Product`, `Policy`, `AgentRequest`, `PolicyDecision`, `Approval`, `PaymentAttempt`, `PaymentMandate`, `AuditEvent`.
- [x] **Integer Paise Precision:** Complete eradication of floating-point math across all financial operations.
- [x] **Deterministic Policy Evaluator:** Single-order caps (₹2,000), 24h spend limits (₹5,000), category whitelist, velocity burst limiters.
- [x] **Unit Testing:** 23 comprehensive tests in Vitest validating all boundary conditions and error paths.

---

## Phase 2: Autonomous Commerce & Consolidated Consent (COMPLETED ✅)
- [x] **Consolidated Consent ₹1 Setup:** One-time mandate verification capturing card network, last 4 digits, and token reference.
- [x] **Zero-OTP In-Context Debits (< ₹1,000):** Autonomous payment execution within user consent boundaries without popups or OTP prompts.
- [x] **Dual-Control Human Review (> ₹1,000):** Real-time generation of Razorpay Hosted Payment Links with active status reconciliation.
- [x] **Model Context Protocol (MCP) Server:** JSON-RPC 2.0 endpoint (`/api/mcp`) and stdio transport for Claude Desktop and ChatGPT Custom GPTs.

---

## Phase 3: Hardening, Anti-Hallucination & Telemetry (COMPLETED ✅)
- [x] **Anti-Hallucination Circuit Breakers:** Idempotency quarantines and runaway retry locks preventing duplicate charges on timeout.
- [x] **Millisecond Telemetry:** High-precision `latencyMs`, `requestedAt`, `evaluatedAt`, and `debitedAt` logging.
- [x] **Active Razorpay API Polling:** Automatic reconciliation of payment links and orders via REST gateway adapter.
- [x] **Incident Post-Mortem Documentation:** Exhaustive error logging in `uploads/Errors_encountered.md`.

---

## Phase 4: Production Deployment & Scale (IN PROGRESS 🚀)
- [x] **Local SQLite Engine:** Zero-config offline development and test runner.
- [x] **Supabase PostgreSQL Integration:** IPv4 connection pooling (`pgbouncer=true` on port 6543) and migration readiness.
- [ ] **Vercel Edge Deployment:** Serverless edge deployment of Next.js frontend and MCP API gateway.
- [ ] **Multi-Merchant Multi-Tenant Partitioning:** Isolated policy engines and cryptographic Merkle chains per merchant ID.
