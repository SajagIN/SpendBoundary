# SpendBoundary — UI & UX Design System

## 1. Design Philosophy: The Financial Control Room

SpendBoundary is designed to look and feel like an enterprise **Financial Control Room & Policy Firewall** for autonomous AI commerce. It deliberately avoids standard e-commerce templates, placing immediate visual emphasis on:
- **Decision Visibility:** Immediate identification of `ALLOW`, `REVIEW`, and `DENY` states.
- **Rule Transparency:** Clear, human-readable explanations of *why* an action was permitted or blocked.
- **Autonomous vs. Human Boundary:** Visual distinction between zero-OTP autonomous debits and human authorization gates.
- **Cryptographic Trust:** Visible SHA-256 Merkle block hashes and real-time chain validation indicators.

---

## 2. Color Palette & Visual Tokens

A dark navy foundation (`#0B1220`) with glassmorphic semi-transparent cards, crisp borders, and semantic decision accents:

| Token Name | Hex Code | Purpose & Usage |
|---|---|---|
| **Canvas Background** | `#0B1220` | Deep slate navy body canvas |
| **Surface Dark** | `#111C2E` | Secondary panels, sidebars, and sub-cards |
| **Surface Card** | `rgba(255, 255, 255, 0.04)` | Glassmorphic card surfaces with subtle backdrop blur |
| **Border Subtle** | `rgba(255, 255, 255, 0.08)` | Dividers, card borders, and input outlines |
| **ALLOW (Emerald)** | `#10B981` | Approved policy decisions, active card mandates, verified chain |
| **REVIEW (Amber)** | `#F59E0B` | Human approval required, pending payment links, threshold triggers |
| **DENY (Rose)** | `#EF4444` | Policy violations, velocity limit bursts, blocked items, tamper alert |
| **MCP / AI (Indigo)** | `#6366F1` | Agent tool calls, Model Context Protocol badges, AI actions |
| **Primary Accent (Cyan/Blue)** | `#3B82F6` | Primary action buttons, interactive toggles, active tabs |
| **Text Primary** | `#F8FAFC` | Main headings, key values, table data |
| **Text Muted** | `#94A3B8` | Secondary labels, descriptions, hash snippets |

---

## 3. Typography & Formatting

- **Font Family:** `Inter`, system-ui, sans-serif.
- **Monospace Font:** `ui-monospace`, `SFMono-Regular`, `Consolas` (for SHA-256 hashes, Request IDs, JSON payloads, and MCP commands).
- **Financial Formatting:** All amounts are formatted in Indian Rupees using the Indian numbering system (`₹1,500.00`, `₹5,000.00`).
- **Hierarchy:**
  - Page Titles: 24–28px, Bold (`text-2xl font-bold`).
  - Section Headers: 16–18px, Semibold (`text-lg font-semibold`).
  - Metric Numbers: 20–24px, Bold Monospace (`text-xl font-mono font-bold`).
  - Body Text: 14px, Regular (`text-sm`).
  - Micro-metadata: 12px (`text-xs text-slate-400`).

---

## 4. Main Application Layout

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│  🛡️ SpendBoundary   [Demo Mode]   [Reset Spend (₹0)]   [Daily Spent: ₹350]   [Mandate: RuPay •••• 1005]  │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│  [🤖 Agent Console] [⚖️ Policy Editor] [📦 Catalogue] [⏳ Approvals (0)] [📜 Audit Ledger] [🔌 MCP Guide]│
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                  │
│                                  ACTIVE TAB CONTENT AREA                                         │
│                                                                                                  │
│   • Live Tool Call Telemetry       • Parameter Sliders           • SKU Inventory Grid           │
│   • Cart Recalculation Inspector   • Category Whitelist Toggles  • Human Review Cards           │
│   • Policy Decision Banner         • Merkle Timeline Replay      • MCP Configuration Generator  │
│                                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Core Components & Visual Specifications

### 5.1 Top Navigation & Live KPI Bar
- **Logo & Status Badge:** Displays the active environment (`Demo Mode / Razorpay Test`) and live database connectivity indicator.
- **Live Metrics:**
  - `Daily Spent`: Live accumulated 24h spend vs total daily cap (`₹350 / ₹5,000`).
  - `Payment Mandate`: Card badge (`RuPay •••• 1005 — ACTIVE (₹1,000 Limit)`).
  - `Approvals Queue`: Active pending reviews badge with animated pulse when $>0$.
  - `Ledger Integrity`: Real-time cryptographic status (`Chain Verified ✅` or `Tamper Detected ⚠️`).
- **Reset Button:** One-click `[Reset Spend (₹0)]` button to clear daily test balances.

### 5.2 Agent Console (`components/AgentConsole.tsx`)
- **Left Column (Goal & Conversation):** Pre-configured 1-click test scenarios ("Buy ₹500 Office Supplies", "Overspend ₹8,000", "Review ₹1,500 Lamp", "Blocked Crypto Miner") plus custom prompt input.
- **Right Column (Cart & Policy Decision):**
  - Live Cart Snapshot with server-verified unit prices.
  - Decision Banner with high-contrast badge (`ALLOW` / `REVIEW` / `DENY`).
  - Rule Breakdown Card detailing triggered limits and requested amounts.
  - Tool Calling Telemetry stream with raw JSON inspection drawers.

### 5.3 Policy Editor (`components/PolicyEditor.tsx`)
- Interactive sliders for Max Order Value (`₹100 – ₹10,000`) and Daily Spend Cap (`₹500 – ₹50,000`).
- Category Whitelist chips with instant toggle switches (`Office Supplies`, `Electronics`, `Home Office`, `Furniture`).
- Velocity limiter inputs (Requests count & sliding window seconds).
- Instant live update to SQLite database with optimistic UI feedback.

### 5.4 Human Approvals Queue (`components/ApprovalsView.tsx`)
- Cards for transactions held above the threshold.
- Highlights: Agent Reason, Cart Contents, Policy Trigger (`APPROVAL_THRESHOLD_TRIGGERED`).
- Customer Payment Link indicator badge (`https://rzp.io/rzp/...`).
- Administrative Merchant override buttons: `[Approve & Execute]` and `[Reject]`.

### 5.5 Cryptographic Audit Ledger (`components/AuditLedger.tsx`)
- Chronological timeline of all system events (`POLICY_DECISION_EVALUATED`, `PAYMENT_ATTEMPT_RECORDED`, `PAYMENT_MANDATE_ACTIVATED`, `MANDATE_AUTO_DEBIT_CAPTURED`).
- Monospace block hashes displaying `Event Hash` and linked `Previous Hash`.
- Interactive **"Simulate Tamper"** button: deliberately alters a historical record in SQLite to demonstrate immediate hash mismatch and red alert banner.

### 5.6 MCP Guide & Simulator (`components/MCPGuide.tsx`)
- 1-Click Copy configuration for Claude Desktop (`claude_desktop_config.json`).
- Step-by-step setup guide for ChatGPT Custom GPT Actions.
- Interactive in-browser MCP tool execution simulator.
