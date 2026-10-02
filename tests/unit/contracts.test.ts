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
