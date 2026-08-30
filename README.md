# SpendBoundary 🛡️

**Policy-gated payments and execution firewall for autonomous AI agents.**

Let an AI agent shop on its own, and keep the human in control of the money. SpendBoundary sits
between the agent and the payment gateway: the agent gets SKUs, policy limits and a decision — it
never sees a card number, a token, or a Razorpay key.

```text
ALLOW  (< ₹1,000)  → tokenized card mandate, zero-OTP debit inside the chat
REVIEW (≥ ₹1,000)  → autonomous debit halted, hosted Razorpay link for human OTP
DENY   (violation) → blocked at the gateway, zero payment calls created
```

Every request, decision, approval and capture is sealed into an append-only SHA-256 Merkle chain.

---

## Quick start

```bash
npm install
npm run setup     # prisma db push + seed the catalogue and policy
npm run dev       # http://localhost:3000
npm test          # 48 tests
```

No Razorpay keys are required. With `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` unset the gateway
adapter runs a deterministic mock (every response carries `simulated: true` and the dashboard shows
`Mock Gateway`). Add test keys to `.env.local` and the same code path talks to the live Razorpay
REST API instead.

`.env.local`:

```env
DATABASE_URL="file:./dev.db"
DEMO_MODE=true
RAZORPAY_KEY_ID=""
RAZORPAY_KEY_SECRET=""
SPENDBOUNDARY_BASE_URL="http://localhost:3000"
```

For Supabase PostgreSQL, switch the `provider` in `prisma/schema.prisma` to `postgresql`, uncomment
`directUrl`, and point `DATABASE_URL` at the IPv4 transaction pooler on port 6543 with
`?pgbouncer=true` (the direct `db.<ref>.supabase.co` host is IPv6-only — see `uploads/Errors_encountered.md`
E04/E05).

---

## Trying it in 60 seconds

Open the dashboard, press **Complete ₹1 Setup** in the header to activate the card mandate, then run
the one-click scenarios in the Agent Console:

| Scenario | What it proves |
|---|---|
| Buy ₹350 notebook | ALLOW — debited against the stored mandate, zero OTP, a real `order_…` id |
| Review ₹1,500 desk lamp | REVIEW — debit halted, hosted `rzp.io/…` link created, approvals queue lights up |
| Blocked ₹5,000 crypto miner | DENY — category is not whitelisted, no gateway call at all |
| Overspend ₹8,000 chair | DENY — single-order cap |
| Velocity burst ×4 | The 4th request trips the limiter, then a 15 minute circuit-breaker lockout |
| Gateway timeout on debit | The debit is quarantined as `DEBIT_IN_PROGRESS`; the immediate retry is blocked |
| Hallucinated ₹1 price | The agent's claimed price is discarded; the database price is charged |

Then open **Audit Ledger → Simulate Tamper**: one historical payload is edited in SQLite and the
verifier names the exact broken block. **Restore** puts the payload back and the chain re-verifies.

---

## How it works

```text
Agent (Claude Desktop / ChatGPT / REST)
        │  JSON-RPC 2.0 or REST
        ▼
1. Cart re-priced from the database in integer paise      lib/checkout.ts
2. Deterministic policy engine (5 rules, pure function)   lib/policy.ts
3. Branch: auto-debit | hosted link | hard veto           lib/checkout.ts
4. Idempotency quarantine on ambiguous gateway status     lib/checkout.ts
5. SHA-256 Merkle audit event appended                    lib/audit.ts
        │
        ├── SQLite / Supabase PostgreSQL (Prisma)
        └── Razorpay REST (or the deterministic mock)     lib/razorpay.ts
```

**The rules** (all configurable live from the Policy Editor tab):

| Rule | Default |
|---|---|
| R-01 Single-order cap | ₹2,000 (200,000 paise) |
| R-02 24h rolling spend cap | ₹5,000 (500,000 paise) |
| R-03 Category whitelist | Office Supplies, Electronics, Home Office, Furniture |
| R-04 Velocity burst limiter | 3 requests / 60s, then a 900s lockout |
| R-05 Human-review threshold | ₹1,000 (100,000 paise) |

**Invariants**

- Integer paise everywhere. No floating point in the engine or the adapters.
- Anything the LLM asserts about price is recorded for audit and then discarded.
- An ambiguous debit is quarantined, never retried — the agent is told to poll, not to charge again.
- `EventHash = SHA-256(previousHash + payloadJson + eventType + createdAt)`, genesis = 64 zeros.

---

## Connecting an agent

### Claude Desktop (stdio MCP)

Add to `claude_desktop_config.json` (`%APPDATA%\Claude\` on Windows,
`~/Library/Application Support/Claude/` on macOS) — the MCP Guide tab renders this with your real
path and a copy button:

```json
{
  "mcpServers": {
    "spendboundary": {
      "command": "npx",
      "args": ["-y", "tsx", "<ABSOLUTE_PATH>/scripts/mcp-server.ts"]
    }
  }
}
```

The stdio server runs the gateway in-process against the same database, so it works with or without
`npm run dev`. Set `SPENDBOUNDARY_BASE_URL` to proxy tool calls to a deployed instance instead.

### ChatGPT Custom GPT Actions

Import `http://localhost:3000/openapi.json` (OpenAPI 3.1) under Configure → Actions. After changing
the URL, start a **new chat** — ChatGPT caches the action schema per thread.

### Tools

`search_catalogue` · `get_product` · `get_policy_limits` · `request_checkout` ·
`check_approval_status` · `cancel_request`

Every tool result carries an `agentGuidance` string telling the model exactly what it may and may
not do next ("Do NOT submit this cart again", "poll instead of retrying").

---

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/mcp` | JSON-RPC 2.0 MCP endpoint (`GET` for discovery) |
| `POST` | `/api/checkout` | Submit a cart for evaluation and execution |
| `GET` | `/api/requests/{id}` | Poll and reconcile a request |
| `GET` | `/api/catalogue` | Search SKUs |
| `GET`/`PATCH` | `/api/policy` | Read / update the policy |
| `GET`/`POST` | `/api/approvals` | Review queue; approve or reject |
| `GET`/`POST` | `/api/audit` | Ledger + verification; tamper / restore |
| `GET`/`POST` | `/api/mandate` | Mandate state; authorize or revoke |
| `GET` | `/api/dashboard` | Aggregated KPIs for the control room |
| `POST` | `/api/reset` | Clear transactional state (`{"wipeLedger":true}` also clears the chain) |

---

## Tests

```bash
npm test
```

48 Vitest tests against a throwaway `prisma/test.db` (the dev database is never touched):

- `tests/money.test.ts` — integer paise invariants and Indian number formatting
- `tests/policy.test.ts` — every zone, every rule, and the threshold boundaries (₹999.99 vs ₹1,000.00)
- `tests/audit.test.ts` — chain verification against edited payloads, rewritten links and deleted blocks
- `tests/checkout.integration.test.ts` — the full pipeline: AC-01 to AC-06, quarantine, dedupe, mandate gating

---

## Project layout

```text
app/            Next.js 15 App Router pages and API routes
components/     The control-room dashboard (glassmorphic dark UI)
lib/            money · policy · audit · razorpay · mandate · checkout · mcp
prisma/         schema (8 models) + seed
scripts/        stdio MCP server for Claude Desktop
tests/          Vitest suites
public/         OpenAPI 3.1 schema for ChatGPT Actions
uploads/        PRD, Architecture, Rules, Phases, Design, incident log
```

Built with Next.js 15, React 19, Prisma, SQLite/Supabase PostgreSQL, Tailwind CSS and the Razorpay
API. MIT licensed.
