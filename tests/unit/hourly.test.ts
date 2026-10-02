import { it, expect } from "vitest";
import {
  evaluateHour,
  isQuiet,
  type Tick,
} from "../../apps/dashboard/src/clock/hourly";
import { parseSettings } from "../../packages/contracts/src/index";
const s = parseSettings({ timeZone: "UTC" });
const tick = (iso: string, mono = 0, generation = 0, visible = true): Tick => ({
  wallMs: Date.parse(iso),
  monoMs: mono,
  generation,
  visible,
});
const before = tick("2026-10-02T09:59:59Z");
it.each([
  [2000, 3000, 10],
  [10000, 11000, 10],
  [10001, 11001, null],
])("enforces inclusive ten-second window %d", (offset, elapsed, hour) => {
  expect(
    evaluateHour(
      before,
      {
        ...before,
        wallMs: Date.parse("2026-10-02T10:00:00Z") + offset,
        monoMs: elapsed,
      },
      s,
    ).hour,
  ).toBe(hour);
});
it("never announces on first load", () =>
  expect(evaluateHour(null, tick("2026-10-02T10:00:00Z"), s).key).toBeNull());
it.each(["generation", "hidden", "jump", "rewind"])(
  "suppresses discontinuity %s",
  (kind) => {
    const current = tick(
      "2026-10-02T10:00:02Z",
      kind === "jump" ? 0 : 3000,
      kind === "generation" ? 1 : 0,
      kind !== "hidden",
    );
    if (kind === "rewind") current.wallMs -= 60000;
    expect(evaluateHour(before, current, s).key).toBeNull();
  },
);
it("does not replay later ticks in same hour", () =>
  expect(
    evaluateHour(
      tick("2026-10-02T10:00:01Z"),
      tick("2026-10-02T10:00:02Z", 1000),
      s,
    ).key,
  ).toBeNull());
it("quiet includes start and excludes end across midnight", () => {
  const q = parseSettings({
    timeZone: "UTC",
    quiet: { enabled: true, start: "22:00", end: "07:00" },
  });
  expect(isQuiet(Date.parse("2026-10-02T22:00Z"), q)).toBe(true);
  expect(isQuiet(Date.parse("2026-10-02T06:59:59Z"), q)).toBe(true);
  expect(isQuiet(Date.parse("2026-10-02T07:00Z"), q)).toBe(false);
});
it("quiet handles daytime interval", () => {
  const q = parseSettings({
    timeZone: "UTC",
    quiet: { enabled: true, start: "10:00", end: "11:00" },
  });
  expect(isQuiet(Date.parse("2026-10-02T10:00Z"), q)).toBe(true);
  expect(isQuiet(Date.parse("2026-10-02T11:00Z"), q)).toBe(false);
});
it.each([
  ["2028-02-28T23:59:59Z", "2028-02-29T00:00:01Z", "UTC", 0],
  ["2026-12-31T23:59:59Z", "2027-01-01T00:00:01Z", "UTC", 0],
  ["2026-03-08T06:59:59Z", "2026-03-08T07:00:01Z", "America/New_York", 3],
  ["2026-11-01T05:59:59Z", "2026-11-01T06:00:01Z", "America/New_York", 1],
])("handles date and DST %s", (a, b, timeZone, hour) =>
  expect(
    evaluateHour(tick(a), tick(b, 2000), parseSettings({ timeZone })).hour,
  ).toBe(hour),
);
it("DST repeated hour shares one claim key", () => {
  const t = parseSettings({ timeZone: "America/New_York" });
  expect(
    evaluateHour(
      tick("2026-11-01T04:59:59Z"),
      tick("2026-11-01T05:00:01Z", 2000),
      t,
    ).key,
  ).toBe(
    evaluateHour(
      tick("2026-11-01T05:59:59Z"),
      tick("2026-11-01T06:00:01Z", 2000),
      t,
    ).key,
  );
});
