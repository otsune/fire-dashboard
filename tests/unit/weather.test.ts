import { it, expect } from "vitest";
import raw from "../fixtures/weather.json";
import { normalizeWeather } from "../../services/aggregator/src/weather/jma";
const captured = "2026-10-01T21:00:00.000Z";
it("keeps regional precip intervals and distinct temperature station", () => {
  const w = normalizeWeather(raw, "TEST01", captured, {
    stationId: "STATION1",
  });
  expect(w.regionLabel).toBe("テスト予報地域");
  expect(w.temperatureStationLabel).toBe("テスト代表地点");
  expect(w.periods.map((p) => p.precipitationProbabilityPct)).toEqual([
    10,
    null,
    40,
  ]);
  expect(w.periods[0].temperatureMaxC).toBe(27);
  expect(w.periods[0].summary).toBe("晴れ");
  expect(w.issuedAt).toBe("2026-10-01T20:00:00.000Z");
});
it("leaves missing numeric fields null and never calls forecast current conditions", () => {
  const w = normalizeWeather(raw, "TEST01", captured);
  expect(w.temperatureStationLabel).toBeNull();
  expect(w.periods[0].temperatureMaxC).toBeNull();
  expect(JSON.stringify(w)).not.toContain("currentTemperature");
});
it("returns unconfigured without region and safely classifies unknown shape", () => {
  expect(normalizeWeather(raw, "", captured).status).toBe("unconfigured");
  expect(
    normalizeWeather({ changed: true }, "TEST01", captured).errorCode,
  ).toBe("invalid_data");
});
it("does not silently pick a different region", () =>
  expect(normalizeWeather(raw, "UNKNOWN", captured).status).toBe("error"));
