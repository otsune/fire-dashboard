// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { App } from "../../apps/dashboard/src/App";
import {
  emptyDashboard,
  type Dashboard,
} from "../../packages/contracts/src/index";
import * as cache from "../../apps/dashboard/src/data/cache";
import * as dashboardClient from "../../apps/dashboard/src/data/client";
import * as weatherClient from "../../apps/dashboard/src/data/weather-settings";
vi.mock("../../apps/dashboard/src/data/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof cache>()),
  loadDashboard: vi.fn(),
  saveDashboard: vi.fn(),
  invalidateDashboardCache: vi.fn(),
}));
vi.mock("../../apps/dashboard/src/data/client", () => ({
  fetchDashboard: vi.fn(),
}));
vi.mock(
  "../../apps/dashboard/src/data/weather-settings",
  async (importOriginal) => ({
    ...(await importOriginal<typeof weatherClient>()),
    fetchWeatherSettings: vi.fn(),
    fetchWeatherOffices: vi.fn(),
    fetchWeatherOffice: vi.fn(),
    saveWeatherSettings: vi.fn(),
  }),
);
vi.mock("../../apps/dashboard/src/audio/manifest", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadManifest: async () => ({ hours: {}, chime: null }),
}));
const oldData: Dashboard = {
  ...emptyDashboard(),
  weather: {
    ...emptyDashboard().weather,
    configurationRevision: "r1",
    regionId: "130010",
    regionLabel: "東京地方",
    temperatureStationLabel: "東京",
    status: "ok",
    lastSuccessAt: "2026-10-03T12:00:00Z",
    periods: [
      {
        startsAt: "2026-10-03T00:00:00Z",
        endsAt: "2099-10-04T00:00:00Z",
        summary: "古い予報",
        weatherCode: "100",
        temperatureMinC: 18,
        temperatureMaxC: 28,
        precipitationProbabilityPct: 0,
      },
    ],
  },
};
const newWeather = {
  ...oldData.weather,
  configurationRevision: "r2",
  temperatureStationLabel: "八王子",
  status: "missing" as const,
  lastSuccessAt: null,
  periods: [],
};
beforeEach(() => {
  vi.mocked(cache.loadDashboard).mockResolvedValue(null);
  vi.mocked(cache.saveDashboard).mockResolvedValue();
  vi.mocked(dashboardClient.fetchDashboard).mockResolvedValue(oldData);
  vi.mocked(weatherClient.fetchWeatherSettings).mockResolvedValue({
    revision: "r1",
    selection: { office: "130000", region: "130010", station: "44132" },
    canEdit: true,
    weather: oldData.weather,
  });
  vi.mocked(weatherClient.fetchWeatherOffices).mockResolvedValue({
    offices: [{ id: "130000", label: "東京都" }],
  });
  vi.mocked(weatherClient.fetchWeatherOffice).mockResolvedValue({
    office: { id: "130000", label: "東京都" },
    regions: [{ id: "130010", label: "東京地方" }],
    stations: [
      { id: "44132", label: "東京" },
      { id: "44133", label: "八王子" },
    ],
  });
  vi.mocked(weatherClient.saveWeatherSettings).mockResolvedValue({
    settings: {
      revision: "r2",
      selection: { office: "130000", region: "130010", station: "44133" },
    },
    weather: newWeather,
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  localStorage.clear();
});
async function openWeather() {
  fireEvent.click(screen.getByRole("button", { name: "天気の地域を設定" }));
  await waitFor(() =>
    expect(screen.getByLabelText("気温の代表地点")).toBeEnabled(),
  );
}
async function saveStation() {
  fireEvent.change(screen.getByLabelText("気温の代表地点"), {
    target: { value: "44133" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("heading", { name: "天気の地域設定" }),
    ).toBeNull(),
  );
}
it("restores stable opener focus for direct and nested settings lifecycles", async () => {
  render(<App />);
  await openWeather();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(
    screen.getByRole("button", { name: "天気の地域を設定" }),
  ).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  await openWeather();
  fireEvent.click(screen.getByRole("button", { name: "戻る" }));
  expect(
    screen.getByRole("button", { name: "天気の地域を設定" }),
  ).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "時計に戻る" }));
  expect(screen.getByRole("button", { name: "設定" })).toHaveFocus();
});
it("applies acknowledged pending weather and ignores an older in-flight poll", async () => {
  let oldPoll!: (value: Dashboard) => void;
  vi.mocked(dashboardClient.fetchDashboard)
    .mockResolvedValueOnce(oldData)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        oldPoll = resolve;
      }),
    )
    .mockResolvedValue({ ...oldData, weather: newWeather });
  render(<App />);
  await screen.findByText("集約サービス接続済み");
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  await openWeather();
  await saveStation();
  expect(cache.invalidateDashboardCache).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("古い予報")).toBeNull();
  await act(async () => oldPoll(oldData));
  expect(screen.queryByText("古い予報")).toBeNull();
  expect(screen.getByText("有効な予報を待っています")).toBeInTheDocument();
  expect(vi.mocked(cache.saveDashboard).mock.calls.at(-1)?.[0].weather).toEqual(
    newWeather,
  );
});
it("ignores cache hydration that arrives after save and preserves unrelated cards", async () => {
  let oldCache!: (value: Dashboard) => void;
  vi.mocked(cache.loadDashboard).mockReturnValueOnce(
    new Promise((resolve) => {
      oldCache = resolve;
    }),
  );
  vi.mocked(dashboardClient.fetchDashboard).mockResolvedValue({
    ...oldData,
    weather: newWeather,
  });
  render(<App />);
  await openWeather();
  await saveStation();
  await act(async () => oldCache(oldData));
  expect(screen.queryByText("古い予報")).toBeNull();
  expect(
    screen.getByRole("heading", { name: /Claude\s*利用状況/ }),
  ).toBeInTheDocument();
});
it("blocks the general navigation button while a region save is pending", async () => {
  vi.mocked(weatherClient.saveWeatherSettings).mockReturnValueOnce(
    new Promise(() => {}),
  );
  render(<App />);
  await openWeather();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(screen.getByRole("button", { name: "設定" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  expect(
    screen.getByRole("heading", { name: "天気の地域設定" }),
  ).toBeInTheDocument();
});
it("ignores an older poll failure after the new weather has been acknowledged", async () => {
  let fail!: (error: Error) => void;
  vi.mocked(dashboardClient.fetchDashboard)
    .mockResolvedValueOnce(oldData)
    .mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    )
    .mockResolvedValue({ ...oldData, weather: newWeather });
  render(<App />);
  await screen.findByText("集約サービス接続済み");
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  await openWeather();
  await saveStation();
  await act(async () => fail(Error("network")));
  expect(screen.getByText("集約サービス接続済み")).toBeInTheDocument();
  expect(screen.queryByText("古い予報")).toBeNull();
});
it("does not report obsolete cache write failures after a save", async () => {
  let fail!: (error: Error) => void;
  vi.mocked(cache.saveDashboard).mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      fail = reject;
    }),
  );
  vi.mocked(dashboardClient.fetchDashboard)
    .mockResolvedValueOnce(oldData)
    .mockResolvedValue({ ...oldData, weather: newWeather });
  render(<App />);
  await screen.findByText("集約サービス接続済み");
  await openWeather();
  await saveStation();
  await act(async () => fail(Error("storage")));
  expect(
    screen.queryByText("カードを保存できません。通信中の表示は続けます"),
  ).toBeNull();
});
