/**
 * Rule R-01 — Integer Paise Currency Standard.
 *
 * Every monetary value in SpendBoundary is a non-negative integer count of
 * paise (1 INR = 100 paise). No floating point arithmetic is permitted
 * anywhere in the policy engine or the gateway adapters.
 */

export const PAISE_PER_RUPEE = 100;

export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * PAISE_PER_RUPEE);
}

export function assertPaise(value: number, label = "amount"): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer paise value, received: ${value}`);
  }
  return value;
}

/** Deterministic integer line total. Rejects fractional or negative quantities. */
export function lineTotalPaise(pricePaise: number, quantity: number): number {
  assertPaise(pricePaise, "pricePaise");
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`quantity must be a positive integer, received: ${quantity}`);
  }
  return pricePaise * quantity;
}

export function sumPaise(values: number[]): number {
  return values.reduce((total, value) => total + assertPaise(value), 0);
}

/** Formats paise using the Indian numbering system, e.g. 150000 -> "₹1,500.00". */
export function formatPaise(paise: number): string {
  const negative = paise < 0;
  const absolute = Math.abs(Math.trunc(paise));
  const rupees = Math.floor(absolute / PAISE_PER_RUPEE);
  const remainder = absolute % PAISE_PER_RUPEE;
  const grouped = groupIndian(rupees);
  return `${negative ? "-" : ""}₹${grouped}.${String(remainder).padStart(2, "0")}`;
}

/** Formats paise without decimals, e.g. 150000 -> "₹1,500". */
export function formatPaiseShort(paise: number): string {
  const rupees = Math.floor(Math.abs(Math.trunc(paise)) / PAISE_PER_RUPEE);
  return `${paise < 0 ? "-" : ""}₹${groupIndian(rupees)}`;
}

/** 1234567 -> "12,34,567" (last three digits, then pairs). */
function groupIndian(value: number): string {
  const digits = String(value);
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}
