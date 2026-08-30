import { describe, expect, it } from "vitest";
import {
  assertPaise,
  formatPaise,
  formatPaiseShort,
  lineTotalPaise,
  rupeesToPaise,
  sumPaise,
} from "../lib/money";

describe("R-01 integer paise currency standard", () => {
  it("converts rupees to integer paise", () => {
    expect(rupeesToPaise(350)).toBe(35_000);
    expect(rupeesToPaise(1_500)).toBe(150_000);
  });

  it("rejects fractional or negative paise", () => {
    expect(() => assertPaise(10.5)).toThrow(/non-negative integer/);
    expect(() => assertPaise(-1)).toThrow(/non-negative integer/);
  });

  it("rejects fractional or zero quantities", () => {
    expect(() => lineTotalPaise(35_000, 0)).toThrow(/positive integer/);
    expect(() => lineTotalPaise(35_000, 1.5)).toThrow(/positive integer/);
  });

  it("multiplies line totals without floating point drift", () => {
    // 0.1 + 0.2 style drift is impossible because everything stays integral.
    expect(lineTotalPaise(10, 3)).toBe(30);
    expect(sumPaise([10, 20])).toBe(30);
    expect(lineTotalPaise(89_900, 7)).toBe(629_300);
  });

  it("formats amounts with the Indian numbering system", () => {
    expect(formatPaise(35_000)).toBe("₹350.00");
    expect(formatPaise(150_000)).toBe("₹1,500.00");
    expect(formatPaise(500_000)).toBe("₹5,000.00");
    expect(formatPaise(12_345_678)).toBe("₹1,23,456.78");
    expect(formatPaiseShort(150_000)).toBe("₹1,500");
  });
});
