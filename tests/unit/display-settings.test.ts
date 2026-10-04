import { describe, it, expect } from "vitest";
import {
  emptyDashboard,
  emptyUsage,
  providerSchema,
  readUsageVisibility,
  usageProviders,
  type Usage,
  type UsageDisplayProvider,
} from "../../packages/contracts/src/index";
import {
  isUsageConfigured,
  shouldShowUsage,
} from "../../apps/dashboard/src/settings/visibility";

const allVisible = {
  claude: true,
  codex: true,
  antigravity: true,
  opencode_go: true,
  hermes_nous: true,
  grok: true,
};
const extraProviders = ["antigravity", "opencode_go", "hermes_nous"] as const;
const at = "2026-10-02T00:00:00.000Z";
const zeroWindow = {
  id: "quota",
  label: "quota",
  usedPercent: 0,
  resetsAt: null,
  windowMinutes: null,
};
const zeroBalance = {
  currency: "USD" as const,
  subscriptionRemaining: 0,
  purchasedRemaining: 0,
  totalRemaining: 0,
  monthlyAllowance: null,
  renewsAt: null,
};

describe("usage display settings", () => {
  it("defaults missing display choices to all six enabled", () => {
    expect(readUsageVisibility(undefined)).toEqual({
      value: allVisible,
      warnings: [],
    });
    expect(readUsageVisibility({})).toEqual({
      value: allVisible,
      warnings: [],
    });
  });
  it("keeps saved booleans and defaults unsaved members", () => {
    expect(readUsageVisibility({ claude: false, grok: false })).toEqual({
      value: { ...allVisible, claude: false, grok: false },
      warnings: [],
    });
  });
  it.each(["yes", 0, null, {}, []])(
    "repairs only an invalid Grok member (%j)",
    (grok) => {
      const r = readUsageVisibility({ claude: false, grok });
      expect(r.value).toEqual({ ...allVisible, claude: false });
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toContain("usageVisibility.grok");
    },
  );
  it("reports each invalid known member separately", () => {
    const r = readUsageVisibility({
      claude: false,
      codex: "no",
      antigravity: 1,
      grok: false,
    });
    expect(r.value).toEqual({ ...allVisible, claude: false, grok: false });
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.join(" ")).toContain("usageVisibility.codex");
    expect(r.warnings.join(" ")).toContain("usageVisibility.antigravity");
  });
  it.each([null, false, "off", 1, []])(
    "recovers a malformed visibility record (%j)",
    (input) => {
      const r = readUsageVisibility(input);
      expect(r.value).toEqual(allVisible);
      expect(r.warnings.length).toBeGreaterThan(0);
    },
  );
  it("ignores unknown keys without retaining them", () => {
    expect(readUsageVisibility({ claude: false, unknown: false })).toEqual({
      value: { ...allVisible, claude: false },
      warnings: [],
    });
  });
  it("returns independent defaults without modifying the input", () => {
    const input = Object.freeze({ claude: false, grok: "yes" });
    const first = readUsageVisibility(input).value;
    first.codex = false;
    expect(readUsageVisibility(undefined).value).toEqual(allVisible);
    expect(input).toEqual({ claude: false, grok: "yes" });
  });
  it("keeps Grok outside the five existing collector provider contracts", () => {
    expect(usageProviders).toEqual([
      "claude",
      "codex",
      "antigravity",
      "opencode_go",
      "hermes_nous",
    ]);
    expect(emptyDashboard().usage.map((value) => value.provider)).toEqual(
      usageProviders,
    );
    expect(providerSchema.safeParse("grok").success).toBe(false);
    const displayProvider: UsageDisplayProvider = "grok";
    expect(readUsageVisibility(undefined).value[displayProvider]).toBe(true);
  });
});

describe("usage display filtering", () => {
  it("treats missing usage as unconfigured", () => {
    expect(isUsageConfigured(undefined)).toBe(false);
  });
  it.each(extraProviders)(
    "hides untouched %s even when enabled",
    (provider) => {
      expect(isUsageConfigured(emptyUsage(provider))).toBe(false);
      expect(shouldShowUsage(provider, undefined, allVisible)).toBe(false);
      expect(shouldShowUsage(provider, emptyUsage(provider), allVisible)).toBe(
        false,
      );
    },
  );
  it.each(["claude", "codex"] as const)(
    "preserves the existing empty %s card when enabled",
    (provider) => {
      expect(shouldShowUsage(provider, undefined, allVisible)).toBe(true);
      expect(shouldShowUsage(provider, emptyUsage(provider), allVisible)).toBe(
        true,
      );
    },
  );
  it.each<Partial<Usage>>([
    { sourceAlias: "pc" },
    { capturedAt: at },
    { receivedAt: at },
    { sourceObservedAt: at },
    { status: "ok" },
    { status: "stale" },
    { status: "missing" },
    { status: "error", errorCode: "auth" },
    { status: "unsupported", errorCode: "unsupported" },
    { buckets: [{ id: "quota", label: "quota", windows: [zeroWindow] }] },
    { balance: zeroBalance },
  ])(
    "keeps reporting or data-bearing additional usage visible (%j)",
    (fields) => {
      for (const provider of extraProviders) {
        const value = { ...emptyUsage(provider), ...fields };
        expect(isUsageConfigured(value)).toBe(true);
        expect(shouldShowUsage(provider, value, allVisible)).toBe(true);
      }
    },
  );
  it("retains the existing last-success-only unconfigured behavior", () => {
    const value = { ...emptyUsage("antigravity"), lastSuccessAt: at };
    expect(isUsageConfigured(value)).toBe(false);
    expect(shouldShowUsage("antigravity", value, allVisible)).toBe(false);
  });
  it.each(Object.keys(allVisible) as UsageDisplayProvider[])(
    "always hides %s when manually disabled",
    (provider) => {
      const visibility = { ...allVisible, [provider]: false };
      const value =
        provider === "grok"
          ? undefined
          : { ...emptyUsage(provider), status: "error" as const };
      expect(shouldShowUsage(provider, value, visibility)).toBe(false);
      expect(shouldShowUsage(provider, undefined, visibility)).toBe(false);
    },
  );
  it("never fabricates a Grok card in stage one", () => {
    expect(shouldShowUsage("grok", undefined, allVisible)).toBe(false);
    expect(shouldShowUsage("grok", emptyUsage("claude"), allVisible)).toBe(
      false,
    );
  });
  it("filters without changing retained usage data or observation times", () => {
    const value: Usage = {
      ...emptyUsage("hermes_nous"),
      status: "error",
      errorCode: "auth",
      sourceAlias: "pc",
      sourceObservedAt: at,
      capturedAt: at,
      receivedAt: at,
      lastSuccessAt: at,
      buckets: [{ id: "quota", label: "quota", windows: [zeroWindow] }],
      balance: zeroBalance,
    };
    const before = structuredClone(value);
    const visibility = Object.freeze({ ...allVisible, hermes_nous: false });
    expect(isUsageConfigured(value)).toBe(true);
    expect(shouldShowUsage("hermes_nous", value, visibility)).toBe(false);
    expect(shouldShowUsage("hermes_nous", value, allVisible)).toBe(true);
    expect(value).toEqual(before);
    expect(visibility.hermes_nous).toBe(false);
  });
});
