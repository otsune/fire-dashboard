import { afterEach, expect, it, vi } from "vitest";
import { emptyWeather } from "../../packages/contracts/src/index";
import {
  fetchWeatherSettings,
  fetchWeatherOffices,
  fetchWeatherOffice,
  saveWeatherSettings,
  WeatherSettingsError,
} from "../../apps/dashboard/src/data/weather-settings";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const state = { revision: "r1", selection: null };
it("validates same-origin settings and catalog responses", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ ...state, canEdit: false, weather: emptyWeather() }),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(
    (await fetchWeatherSettings(new AbortController().signal)).canEdit,
  ).toBe(false);
  expect(fetcher.mock.calls[0]).toEqual([
    "/api/v1/weather-settings",
    expect.objectContaining({
      credentials: "same-origin",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    }),
  ]);
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({ offices: [{ id: "130000", label: "東京" }] }),
      ),
  );
  expect(
    (await fetchWeatherOffices(new AbortController().signal)).offices[0].label,
  ).toBe("東京");
});
it("rejects malformed and oversized responses and arbitrary office IDs", async () => {
  vi.stubGlobal("fetch", async () => new Response("{}"));
  await expect(
    fetchWeatherSettings(new AbortController().signal),
  ).rejects.toMatchObject({ code: "invalid_data" });
  vi.stubGlobal("fetch", async () => new Response(" ".repeat(600000)));
  await expect(
    fetchWeatherOffices(new AbortController().signal),
  ).rejects.toMatchObject({ code: "too_large" });
  await expect(
    fetchWeatherOffice("https://example.com", new AbortController().signal),
  ).rejects.toThrow();
});
it("surfaces definitive conflicts and never reports an ambiguous write as cancelled", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ error: "revision_conflict" }), {
        status: 409,
      }),
  );
  await expect(saveWeatherSettings(state)).rejects.toMatchObject({
    code: "revision_conflict",
    uncertain: false,
  });
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("offline");
  });
  await expect(saveWeatherSettings(state)).rejects.toMatchObject({
    code: "network",
    uncertain: true,
  });
});
it("times out a pending save with uncertain acknowledgement", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    (_url: string, options: RequestInit) =>
      new Promise((_resolve, reject) =>
        options.signal!.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        ),
      ),
  );
  const result = saveWeatherSettings(state).catch((error) => error);
  await vi.advanceTimersByTimeAsync(10001);
  expect(await result).toBeInstanceOf(WeatherSettingsError);
  expect(await result).toMatchObject({ code: "timeout", uncertain: true });
});
it("validates acknowledged weather and sends only canonical settings fields", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          settings: { ...state, revision: "r2" },
          weather: { ...emptyWeather(), configurationRevision: "r2" },
        }),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  expect((await saveWeatherSettings(state)).weather.configurationRevision).toBe(
    "r2",
  );
  expect(fetcher.mock.calls[0]).toEqual([
    "/api/v1/weather-settings",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify(state),
      headers: expect.objectContaining({ "Content-Type": "application/json" }),
    }),
  ]);
});
