import { describe, expect, it } from "vitest";
import {
  signRazorpayResponse,
  validateRazorpayResponse,
  verifyWebhookSignature,
  type RazorpayResponse,
} from "../lib/razorpay";
import { POST as handleWebhook } from "../app/api/webhooks/razorpay/route";
import { loadAndVerifyChain } from "../lib/audit";
import { createHmac } from "node:crypto";

const TEST_SECRET = "secret_key_rzp_test_12345";

describe("S-10: Gateway Response Integrity & Checksum Verification", () => {
  it("validates a legitimate, fresh response with a valid checksum", () => {
    const data = {
      id: "pay_test_999",
      amount: 35000,
      currency: "INR",
      status: "captured",
    };
    const timestamp = Date.now();
    const { checksum } = signRazorpayResponse(data, TEST_SECRET, timestamp);

    const response: RazorpayResponse = {
      data,
      checksum,
      timestamp,
    };

    const isValid = validateRazorpayResponse(response, TEST_SECRET);
    expect(isValid).toBe(true);
  });

  it("handles non-alphabetical JSON key ordering transparently with canonical serialization", () => {
    const data1 = { a: 1, b: 2, c: { x: 10, y: 20 } };
    const data2 = { c: { y: 20, x: 10 }, b: 2, a: 1 };
    const timestamp = Date.now();

    const { checksum } = signRazorpayResponse(data1, TEST_SECRET, timestamp);

    const response: RazorpayResponse = {
      data: data2,
      checksum,
      timestamp,
    };

    expect(validateRazorpayResponse(response, TEST_SECRET)).toBe(true);
  });

  it("rejects responses with expired timestamps (> 5 min old) as replay attempts", () => {
    const data = { id: "pay_expired_1", amount: 50000 };
    const expiredTimestamp = Date.now() - (5 * 60 * 1000 + 1000); // 5 min 1 sec ago
    const { checksum } = signRazorpayResponse(data, TEST_SECRET, expiredTimestamp);

    const response: RazorpayResponse = {
      data,
      checksum,
      timestamp: expiredTimestamp,
    };

    const isValid = validateRazorpayResponse(response, TEST_SECRET);
    expect(isValid).toBe(false);
  });

  it("rejects responses with future-dated timestamps (> 5 min in future)", () => {
    const data = { id: "pay_future_1", amount: 50000 };
    const futureTimestamp = Date.now() + (5 * 60 * 1000 + 5000);
    const { checksum } = signRazorpayResponse(data, TEST_SECRET, futureTimestamp);

    const response: RazorpayResponse = {
      data,
      checksum,
      timestamp: futureTimestamp,
    };

    expect(validateRazorpayResponse(response, TEST_SECRET)).toBe(false);
  });

  it("rejects responses with invalid, NaN, or non-numeric timestamps", () => {
    const response1 = { data: {}, checksum: "abc", timestamp: NaN } as any;
    const response2 = { data: {}, checksum: "abc", timestamp: -100 } as any;
    const response3 = { data: {}, checksum: "abc", timestamp: "now" } as any;

    expect(validateRazorpayResponse(response1, TEST_SECRET)).toBe(false);
    expect(validateRazorpayResponse(response2, TEST_SECRET)).toBe(false);
    expect(validateRazorpayResponse(response3, TEST_SECRET)).toBe(false);
  });

  it("detects tampered response data and rejects checksum", () => {
    const data = { id: "pay_tamper_1", amount: 35000 };
    const timestamp = Date.now();
    const { checksum } = signRazorpayResponse(data, TEST_SECRET, timestamp);

    // Attacker modifies amount from 35000 to 3500
    const tamperedResponse: RazorpayResponse = {
      data: { id: "pay_tamper_1", amount: 3500 },
      checksum,
      timestamp,
    };

    expect(validateRazorpayResponse(tamperedResponse, TEST_SECRET)).toBe(false);
  });

  it("detects tampered timestamps with matching payload", () => {
    const data = { id: "pay_timestamp_tamper", amount: 35000 };
    const timestamp = Date.now();
    const { checksum } = signRazorpayResponse(data, TEST_SECRET, timestamp);

    const tamperedResponse: RazorpayResponse = {
      data,
      checksum,
      timestamp: timestamp - 1000, // Modified timestamp
    };

    expect(validateRazorpayResponse(tamperedResponse, TEST_SECRET)).toBe(false);
  });

  it("rejects verification with wrong secret key", () => {
    const data = { id: "pay_wrong_secret", amount: 35000 };
    const timestamp = Date.now();
    const { checksum } = signRazorpayResponse(data, TEST_SECRET, timestamp);

    const response: RazorpayResponse = {
      data,
      checksum,
      timestamp,
    };

    expect(validateRazorpayResponse(response, "wrong_secret_key")).toBe(false);
  });

  it("enforces checksum requirement when requireChecksum option is true", () => {
    const responseWithoutChecksum: RazorpayResponse = {
      data: { id: "pay_no_checksum", amount: 1000 },
      timestamp: Date.now(),
    };

    expect(validateRazorpayResponse(responseWithoutChecksum, TEST_SECRET, { requireChecksum: true })).toBe(false);
  });

  it("verifies Razorpay webhook HMAC signatures correctly", () => {
    const payload = JSON.stringify({
      entity: "event",
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
    });
    const signature = createHmac("sha256", TEST_SECRET).update(payload).digest("hex");

    expect(verifyWebhookSignature(payload, signature, TEST_SECRET)).toBe(true);

    // Tampered body fails
    expect(verifyWebhookSignature(payload + " ", signature, TEST_SECRET)).toBe(false);

    // Tampered signature fails
    expect(verifyWebhookSignature(payload, signature.slice(0, -1) + "0", TEST_SECRET)).toBe(false);

    // Wrong secret fails
    expect(verifyWebhookSignature(payload, signature, "different_secret")).toBe(false);
  });

  it("processes inbound webhooks via the API route and seals events into audit chain", async () => {
    const secret = "spendboundary_demo_secret";
    const bodyObj = {
      entity: "event",
      event: "payment_link.paid",
      event_id: "evt_test_12345",
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment_link: {
          entity: {
            id: "plink_test_123",
            reference_id: "mandate_setup_test",
          },
        },
        payment: {
          entity: {
            id: "pay_webhook_test",
            card: { network: "RuPay", last4: "1005" },
          },
        },
      },
    };
    const rawBody = JSON.stringify(bodyObj);
    const signature = createHmac("sha256", secret).update(rawBody).digest("hex");

    const request = new Request("http://localhost:3000/api/webhooks/razorpay", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": signature,
      },
      body: rawBody,
    });

    const response = await handleWebhook(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.received).toBe(true);

    const { events, verification } = await loadAndVerifyChain();
    expect(verification.valid).toBe(true);
    expect(events.some((e) => e.eventType === "WEBHOOK_RECEIVED")).toBe(true);
  });

  it("rejects webhooks with missing or invalid signatures with 400 Bad Request", async () => {
    const requestMissing = new Request("http://localhost:3000/api/webhooks/razorpay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "payment.captured" }),
    });

    const resMissing = await handleWebhook(requestMissing);
    expect(resMissing.status).toBe(400);

    const requestInvalid = new Request("http://localhost:3000/api/webhooks/razorpay", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": "invalid_signature_hex",
      },
      body: JSON.stringify({ event: "payment.captured" }),
    });

    const resInvalid = await handleWebhook(requestInvalid);
    expect(resInvalid.status).toBe(400);
  });
});
