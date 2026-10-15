import { describe, expect, it } from "vitest";
import {
  fetchHermesNousUsage,
  normalizeHermesNousApi,
} from "../../collectors/hermes-nous/api";

const at = "2026-10-16T00:00:00.000Z";

it("normalizes the Hermes Nous account snapshot into USD balance and quota", () => {
  const value = normalizeHermesNousApi(
    {
      available: true,
      balance: {
        subscription_remaining: 14,
        purchased_remaining: 12,
        total_remaining: 26,
        monthly_allowance: 20,
        renews_at: "2026-11-01T00:00:00Z",
      },
      windows: [
        {
          label: "Subscription",
          used_percent: 30,
          reset_at: "2026-11-01T00:00:00Z",
        },
      ],
      email: "private@example.test",
      portal_url: "https://private.example.test/account",
    },
    at,
  );
  expect(value).toMatchObject({
    provider: "hermes_nous",
    status: "ok",
    sourceObservedAt: null,
    balance: {
      currency: "USD",
      subscriptionRemaining: 14,
      purchasedRemaining: 12,
      totalRemaining: 26,
      monthlyAllowance: 20,
      renewsAt: "2026-11-01T00:00:00.000Z",
    },
  });
  expect(value.buckets[0].windows[0]).toEqual({
    id: "subscription-0",
    label: "Subscription",
    usedPercent: 30,
    windowMinutes: null,
    resetsAt: "2026-11-01T00:00:00.000Z",
  });
  expect(JSON.stringify(value)).not.toMatch(/private@example|portal_url/);
});

it("does not fabricate values for unavailable or malformed responses", () => {
  expect(
    normalizeHermesNousApi({ available: false, reason: "missing" }, at),
  ).toMatchObject({
    status: "missing",
    errorCode: "missing",
  });
  expect(
    normalizeHermesNousApi({ available: false, reason: "unconfigured" }, at),
  ).toMatchObject({ status: "unconfigured", errorCode: "unconfigured" });
  expect(
    normalizeHermesNousApi(
      {
        available: true,
        balance: { subscription_remaining: -1, monthly_allowance: "20" },
        windows: [],
      },
      at,
    ),
  ).toMatchObject({ status: "error", errorCode: "invalid_data" });
});

describe("Hermes Nous bridge", () => {
  it("passes only a bounded Python path and timeout to the runner", async () => {
    const calls: [string, number][] = [];
    const value = await fetchHermesNousUsage({
      capturedAt: at,
      pythonPath: "/opt/hermes/bin/python",
      timeoutMs: 1500,
      run: async (pythonPath, timeoutMs) => {
        calls.push([pythonPath, timeoutMs]);
        return { available: false, reason: "missing", secret: "PRIVATE" };
      },
    });
    expect(calls).toEqual([["/opt/hermes/bin/python", 1500]]);
    expect(value.errorCode).toBe("missing");
    expect(JSON.stringify(value)).not.toContain("PRIVATE");
  });

  it.each([
    ["timeout", "timeout"],
    ["too_large", "too_large"],
    ["invalid_data", "invalid_data"],
    ["unconfigured", "unconfigured"],
  ] as const)("classifies bridge failure %s", async (message, errorCode) => {
    const value = await fetchHermesNousUsage({
      capturedAt: at,
      run: async () => {
        throw Error(message);
      },
    });
    expect(value.errorCode).toBe(errorCode);
  });
});
