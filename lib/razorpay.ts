import { createHash, randomBytes } from "node:crypto";

/**
 * Razorpay gateway adapter.
 *
 * When RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are present the adapter talks to
 * the live Razorpay REST API over Basic auth. When they are absent it falls
 * back to a deterministic mock so the whole firewall — including the ₹1 mandate
 * consent flow, hosted payment links and tokenized auto-debits — is fully
 * demonstrable offline (Incident E08: the fallback must be explicit, never
 * silent, so every response carries a `simulated` flag).
 */

const API_BASE = "https://api.razorpay.com/v1";

export class GatewayTimeoutError extends Error {
  constructor(message = "Razorpay gateway timed out before confirming the debit") {
    super(message);
    this.name = "GatewayTimeoutError";
  }
}

/**
 * Raised when the account cannot execute a tokenized zero-OTP debit — either
 * recurring payments are not enabled on it (the endpoint 404s) or the stored
 * token was never minted by a genuine authorization transaction.
 *
 * This is NOT an ambiguous gateway status: no money moved and none will. It
 * must never be quarantined as though a debit might still land, and it must
 * never be reported to the agent as a success.
 */
export class RecurringUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecurringUnsupportedError";
  }
}

/** True for tokens this codebase fabricated rather than received from Razorpay. */
export function isFabricatedToken(tokenId: string | null | undefined): boolean {
  return Boolean(tokenId && /^token_[0-9a-f]{14}$/.test(tokenId));
}

export type GatewayOrder = {
  orderId: string;
  amountPaise: number;
  status: string;
  simulated: boolean;
};

export type GatewayPayment = {
  paymentId: string;
  orderId?: string;
  status: string;
  amountPaise: number;
  method?: string;
  cardNetwork?: string;
  cardLast4?: string;
  tokenId?: string;
  customerId?: string;
  simulated: boolean;
};

export type GatewayPaymentLink = {
  linkId: string;
  shortUrl: string;
  status: string; // created | paid | cancelled | expired
  amountPaise: number;
  paymentId?: string;
  simulated: boolean;
};

export function isLiveMode(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

export function gatewayMode(): "LIVE_TEST_KEYS" | "DETERMINISTIC_MOCK" {
  return isLiveMode() ? "LIVE_TEST_KEYS" : "DETERMINISTIC_MOCK";
}

async function razorpayFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const auth = Buffer.from(
    `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`,
  ).toString("base64");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const body = (await response.json()) as T & { error?: { description?: string } };
    if (!response.ok) {
      throw new Error(body?.error?.description ?? `Razorpay ${path} failed (${response.status})`);
    }
    return body;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new GatewayTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Deterministic mock identifiers: same seed always yields the same id. */
function mockId(prefix: string, seed: string): string {
  return `${prefix}${createHash("sha256").update(seed).digest("hex").slice(0, 14)}`;
}

export const razorpayGateway = {
  /** F2 — a genuine Razorpay Order so the merchant dashboard shows the debit. */
  async createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<GatewayOrder> {
    if (!isLiveMode()) {
      return {
        orderId: mockId("order_", input.receipt),
        amountPaise: input.amountPaise,
        status: "created",
        simulated: true,
      };
    }
    const order = await razorpayFetch<{ id: string; amount: number; status: string }>("/orders", {
      method: "POST",
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: "INR",
        receipt: input.receipt,
        notes: input.notes ?? {},
      }),
    });
    return {
      orderId: order.id,
      amountPaise: order.amount,
      status: order.status,
      simulated: false,
    };
  },

  /**
   * F2 — zero-OTP debit against the stored tokenized mandate.
   * `simulateTimeout` reproduces AC-05 (ambiguous gateway status) on demand.
   */
  async debitMandate(input: {
    amountPaise: number;
    orderId: string;
    tokenId: string;
    customerId?: string;
    simulateTimeout?: boolean;
  }): Promise<GatewayPayment> {
    if (input.simulateTimeout) {
      throw new GatewayTimeoutError();
    }
    if (!isLiveMode()) {
      return {
        paymentId: mockId("pay_", input.orderId),
        orderId: input.orderId,
        status: "captured",
        amountPaise: input.amountPaise,
        method: "card",
        tokenId: input.tokenId,
        customerId: input.customerId,
        simulated: true,
      };
    }
    // A token this codebase fabricated can never be charged on live Razorpay.
    // In demo mode we simulate the capture; otherwise fail fast.
    if (isFabricatedToken(input.tokenId)) {
      if (process.env.DEMO_MODE !== "false") {
        return {
          paymentId: mockId("pay_", input.orderId),
          orderId: input.orderId,
          status: "captured",
          amountPaise: input.amountPaise,
          method: "card",
          cardNetwork: "RuPay",
          cardLast4: "1005",
          tokenId: input.tokenId,
          customerId: input.customerId,
          simulated: true,
        };
      }
      throw new RecurringUnsupportedError(
        "The stored mandate holds a placeholder token, not one issued by Razorpay. Complete a genuine ₹1 authorization before any autonomous debit.",
      );
    }

    let payment: {
      razorpay_payment_id?: string;
      id?: string;
      status?: string;
      amount?: number;
      method?: string;
    };
    try {
      payment = await razorpayFetch("/payments/create/recurring", {
        method: "POST",
        body: JSON.stringify({
          order_id: input.orderId,
          token: input.tokenId,
          customer_id: input.customerId,
          amount: input.amountPaise,
          currency: "INR",
          recurring: "1",
        }),
      });
    } catch (error) {
      const message = (error as Error).message ?? "";
      // A 404 here means recurring payments are not enabled on the account.
      if (/not found on the server|not enabled|not supported/i.test(message)) {
        throw new RecurringUnsupportedError(
          `Recurring payments are not enabled on this Razorpay account, so a zero-OTP token debit cannot be executed (gateway said: ${message.trim()})`,
        );
      }
      throw error;
    }
    return {
      paymentId: payment.razorpay_payment_id ?? payment.id ?? "",
      orderId: input.orderId,
      status: payment.status ?? "captured",
      amountPaise: payment.amount ?? input.amountPaise,
      method: payment.method,
      tokenId: input.tokenId,
      customerId: input.customerId,
      simulated: false,
    };
  },

  /** F3 / F1 — hosted payment link for human review and for ₹1 mandate consent. */
  async createPaymentLink(input: {
    amountPaise: number;
    description: string;
    referenceId: string;
    saveCard?: boolean;
  }): Promise<GatewayPaymentLink> {
    if (!isLiveMode()) {
      const linkId = mockId("plink_", input.referenceId);
      return {
        linkId,
        shortUrl: `https://rzp.io/rzp/${linkId.slice(6, 14)}`,
        status: "created",
        amountPaise: input.amountPaise,
        simulated: true,
      };
    }
    const link = await razorpayFetch<{
      id: string;
      short_url: string;
      status: string;
      amount: number;
    }>("/payment_links", {
      method: "POST",
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: "INR",
        description: input.description,
        reference_id: input.referenceId,
        customer: { name: "SpendBoundary Demo User" },
        notify: { sms: false, email: false },
        reminder_enable: false,
        options: input.saveCard ? { checkout: { save: 1 } } : undefined,
      }),
    });
    return {
      linkId: link.id,
      shortUrl: link.short_url,
      status: link.status,
      amountPaise: link.amount,
      simulated: false,
    };
  },

  /**
   * Incident E09 — local dev cannot receive Razorpay webhooks, so the gateway
   * actively polls the link instead of waiting for a callback.
   */
  async fetchPaymentLink(linkId: string): Promise<GatewayPaymentLink> {
    if (!isLiveMode()) {
      return {
        linkId,
        shortUrl: `https://rzp.io/rzp/${linkId.slice(6, 14)}`,
        status: "created",
        amountPaise: 0,
        simulated: true,
      };
    }
    const link = await razorpayFetch<{
      id: string;
      short_url: string;
      status: string;
      amount: number;
      payments?: Array<{ payment_id: string; status: string }>;
    }>(`/payment_links/${linkId}`);
    const captured = link.payments?.find((payment) => payment.status === "captured");
    return {
      linkId: link.id,
      shortUrl: link.short_url,
      status: link.status,
      amountPaise: link.amount,
      paymentId: captured?.payment_id,
      simulated: false,
    };
  },

  /** Extracts the card network, last 4 and token reference from a payment. */
  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    if (!isLiveMode()) {
      return {
        paymentId,
        status: "captured",
        amountPaise: 100,
        method: "card",
        cardNetwork: "RuPay",
        cardLast4: "1005",
        tokenId: mockId("token_", paymentId),
        customerId: mockId("cust_", paymentId),
        simulated: true,
      };
    }
    const payment = await razorpayFetch<{
      id: string;
      order_id?: string;
      status: string;
      amount: number;
      method?: string;
      token_id?: string;
      customer_id?: string;
      card?: { network?: string; last4?: string };
    }>(`/payments/${paymentId}`);
    return {
      paymentId: payment.id,
      orderId: payment.order_id,
      status: payment.status,
      amountPaise: payment.amount,
      method: payment.method,
      cardNetwork: payment.card?.network,
      cardLast4: payment.card?.last4,
      tokenId: payment.token_id,
      customerId: payment.customer_id,
      simulated: false,
    };
  },

  /** Used by the demo "complete this link" control in the dashboard. */
  mockCapture(linkId: string): GatewayPayment {
    return {
      paymentId: mockId("pay_", linkId + randomBytes(0).toString("hex")),
      status: "captured",
      amountPaise: 0,
      method: "card",
      cardNetwork: "RuPay",
      cardLast4: "1005",
      tokenId: mockId("token_", linkId),
      customerId: mockId("cust_", linkId),
      simulated: true,
    };
  },
};
