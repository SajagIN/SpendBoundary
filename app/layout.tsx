import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SpendBoundary — Agentic Commerce Firewall",
  description:
    "Policy-gated payments and execution firewall for autonomous AI agents: 3-zone spend boundaries, tokenized zero-OTP mandates and a SHA-256 Merkle audit ledger.",
};

/**
 * Strips attributes that browser extensions inject into the DOM before React
 * hydrates. Bitdefender stamps bis_skin_checked="1" onto every div (Grammarly
 * and friends do the same with their own names), which React then reports as a
 * hydration mismatch — including on Next's own internal metadata div, where we
 * cannot put a suppressHydrationWarning of our own.
 *
 * This is cosmetic: it silences a development-only warning caused by the
 * viewer's browser, not by application code. The observer is scoped to a fixed
 * list of attribute names and disconnects once hydration has settled.
 */
const STRIP_EXTENSION_ATTRIBUTES = `
(function () {
  var PATTERN = /^(bis_skin_checked|bis_size|bis_id|data-gr-|data-new-gr-|data-gramm)/;
  function clean(element) {
    if (!element || element.nodeType !== 1) return;
    var names = element.getAttributeNames();
    for (var i = 0; i < names.length; i++) {
      if (PATTERN.test(names[i])) element.removeAttribute(names[i]);
    }
  }
  var observer = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      if (record.type === "attributes" && PATTERN.test(record.attributeName)) {
        record.target.removeAttribute(record.attributeName);
      }
    }
  });
  try {
    clean(document.documentElement);
    observer.observe(document.documentElement, { attributes: true, subtree: true });
    window.addEventListener("load", function () {
      setTimeout(function () { observer.disconnect(); }, 3000);
    });
  } catch (error) {
    /* a scrubbing failure must never block the app */
  }
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: STRIP_EXTENSION_ATTRIBUTES }} />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}