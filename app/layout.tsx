import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SpendBoundary — Agentic Commerce Firewall",
  description:
    "Policy-gated payments and execution firewall for autonomous AI agents: 3-zone spend boundaries, tokenized zero-OTP mandates and a SHA-256 Merkle audit ledger.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
