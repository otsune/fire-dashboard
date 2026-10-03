import { it, expect } from "vitest";
import { clockDigitSize } from "../../apps/dashboard/src/clock/fit";
it("uses available face height rather than viewport height", () => {
  expect(clockDigitSize(900, 100, 80)).toBeCloseTo(100 / 1.08);
  expect(clockDigitSize(900, 300, 80)).toBeCloseTo(820 / 3.5);
});
it("reserves seconds, period and gaps before sizing the main digits", () => {
  expect(clockDigitSize(500, 300, 100)).toBeCloseTo(400 / 3.5);
  expect(clockDigitSize(100, 0, 100)).toBe(0);
  expect(clockDigitSize(30, 20, 100)).toBe(0);
});
