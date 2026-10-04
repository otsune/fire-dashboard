import { describe, it, expect } from "vitest";
import {
  parseSettings,
  readSettings,
  parseDashboard,
  emptyDashboard,
  usageSchema,
} from "../../packages/contracts/src/index";
import {
  loadSettings,
  saveSettings,
} from "../../apps/dashboard/src/settings/store";
describe("contracts", () => {
  it("defaults to Tokyo and quiet off", () => {
    const s = parseSettings({});
    expect(s.timeZone).toBe("Asia/Tokyo");
    expect(s.volume).toBe(0.3);
    expect(s.quiet.enabled).toBe(false);
  });
  it("recovers invalid settings while preserving valid fields", () => {
    const r = readSettings({
      timeZone: "Moon",
      volume: 0.7,
      quiet: { enabled: true, start: "07:00", end: "07:00" },
    });
    expect(r.value.volume).toBe(0.7);
    expect(r.value.timeZone).toBe("Asia/Tokyo");
    expect(r.value.quiet.enabled).toBe(false);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  it("restores legacy settings with all six usage displays enabled", () => {
    const legacy = {
      timeZone: "UTC",
      hour12: true,
      audioMode: "both",
      volume: 0.7,
      quiet: { enabled: true, start: "23:00", end: "06:00" },
      rssAutoRotate: false,
    };
    const r = readSettings(legacy);
    expect(r.value).toEqual({
      ...legacy,
      usageVisibility: {
        claude: true,
        codex: true,
        antigravity: true,
        opencode_go: true,
        hermes_nous: true,
        grok: true,
      },
    });
    expect(r.warnings).toEqual([]);
  });
  it("preserves Claude off when the integrated reader repairs invalid Grok", () => {
    const r = readSettings({
      hour12: true,
      volume: 0.8,
      usageVisibility: { claude: false, grok: "yes" },
    });
    expect(r.value).toHaveProperty("usageVisibility.claude", false);
    expect(r.value).toHaveProperty("usageVisibility.grok", true);
    expect(r.value.hour12).toBe(true);
    expect(r.value.volume).toBe(0.8);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("usageVisibility.grok");
  });
  it("round-trips display choices through the existing device settings key", () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    };
    const settings = parseSettings({
      hour12: true,
      volume: 0.7,
      usageVisibility: { claude: false, grok: false },
    });
    expect(saveSettings(settings, storage)).toBe(true);
    expect([...stored.keys()]).toEqual(["fire-dashboard-settings-v1"]);
    const saved = JSON.parse(stored.get("fire-dashboard-settings-v1")!);
    expect(saved).toHaveProperty("usageVisibility.claude", false);
    expect(saved).toHaveProperty("usageVisibility.grok", false);
    expect(loadSettings(storage)).toEqual({ value: settings, warning: null });
  });
  it("surfaces member-specific visibility repair through the settings store", () => {
    const restored = loadSettings({
      getItem: () =>
        JSON.stringify({
          usageVisibility: { claude: false, grok: "yes" },
        }),
    });
    expect(restored.value).toHaveProperty("usageVisibility.claude", false);
    expect(restored.value).toHaveProperty("usageVisibility.grok", true);
    expect(restored.warning).toContain("usageVisibility.grok");
  });
  it("reports broken JSON and quota failures", () => {
    expect(loadSettings({ getItem: () => "{" }).warning).toBeTruthy();
    expect(
      saveSettings(parseSettings({}), {
        setItem: () => {
          throw Error("quota");
        },
      }),
    ).toBe(false);
  });
  it("isolates invalid weather without damaging usage", () => {
    const d = emptyDashboard();
    expect(
      parseDashboard({ ...d, weather: { status: "unknown" } }).weather
        .errorCode,
    ).toBe("invalid_data");
    expect(
      parseDashboard({ ...d, weather: { status: "unknown" } }).usage,
    ).toEqual(d.usage);
  });
  it("strips unknown secrets and preserves null", () => {
    const u = emptyDashboard().usage[0];
    const result = usageSchema.parse({ ...u, token: "secret" });
    expect("token" in result).toBe(false);
    expect(result.sourceObservedAt).toBeNull();
  });
  it("rejects invalid status and out-of-range percentages", () => {
    const u = emptyDashboard().usage[0];
    expect(() => usageSchema.parse({ ...u, status: "whatever" })).toThrow();
    expect(() =>
      usageSchema.parse({
        ...u,
        buckets: [
          {
            id: "x",
            label: "x",
            windows: [
              {
                id: "x",
                label: "x",
                usedPercent: 101,
                windowMinutes: null,
                resetsAt: null,
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });
  it("classifies future timestamps without fabricating freshness", () => {
    const d = emptyDashboard();
    d.usage[0].receivedAt = "2999-01-01T00:00:00.000Z";
    expect(parseDashboard(d).usage[0].errorCode).toBe("clock_skew");
  });
});
