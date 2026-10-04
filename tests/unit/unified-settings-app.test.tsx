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
  within,
} from "@testing-library/react";
import { App } from "../../apps/dashboard/src/App";
import {
  emptyDashboard,
  defaultUsageVisibility,
  type Dashboard,
} from "../../packages/contracts/src/index";
import * as cache from "../../apps/dashboard/src/data/cache";
import * as dashboardClient from "../../apps/dashboard/src/data/client";
import * as weatherClient from "../../apps/dashboard/src/data/weather-settings";
import * as offline from "../../apps/dashboard/src/data/offline";
import { formatTime } from "../../apps/dashboard/src/data/status";

vi.mock("../../apps/dashboard/src/data/cache", async (original) => ({
  ...(await original<typeof cache>()),
  loadDashboard: vi.fn(),
  saveDashboard: vi.fn(),
  invalidateDashboardCache: vi.fn(),
}));
vi.mock("../../apps/dashboard/src/data/client", () => ({
  fetchDashboard: vi.fn(),
}));
vi.mock("../../apps/dashboard/src/data/weather-settings", async (original) => ({
  ...(await original<typeof weatherClient>()),
  fetchWeatherSettings: vi.fn(),
  fetchWeatherOffices: vi.fn(),
  fetchWeatherOffice: vi.fn(),
  saveWeatherSettings: vi.fn(),
}));
vi.mock("../../apps/dashboard/src/audio/manifest", async (original) => ({
  ...(await original<object>()),
  loadManifest: async () => ({ hours: {}, chime: null }),
}));
vi.mock("../../apps/dashboard/src/data/offline", () => ({
  prepareOffline: vi.fn(),
}));

const selection = { office: "130000", region: "130010", station: "44132" };
const weather = {
  ...emptyDashboard().weather,
  configurationRevision: "r1",
  regionId: "130010",
  regionLabel: "東京地方",
  temperatureStationLabel: "東京",
};
const observed = "2026-10-03T12:34:00.000Z";
const data: Dashboard = {
  ...emptyDashboard(),
  weather,
  usage: emptyDashboard().usage.map((value) => ({
    ...value,
    status: "ok",
    receivedAt: observed,
    sourceObservedAt: observed,
    capturedAt: observed,
    lastSuccessAt: observed,
    buckets: [
      {
        id: "quota",
        label: "quota",
        windows: [
          {
            id: "quota",
            label: "quota",
            usedPercent: 37,
            resetsAt: null,
            windowMinutes: null,
          },
        ],
      },
    ],
  })),
};

// Browser delta traversals are queued. Keep this faithful to the controller's
// deterministic regressions rather than jsdom's coalescing native history.
function historyModel() {
  let entries: unknown[] = [{ dashboard: true }],
    index = 0;
  const queue: number[] = [];
  const history = {
    get state() {
      return entries[index];
    },
    get length() {
      return entries.length;
    },
    pushState(state: unknown) {
      entries = entries.slice(0, index + 1);
      entries.push(structuredClone(state));
      index++;
    },
    replaceState(state: unknown) {
      entries[index] = structuredClone(state);
    },
    back() {
      queue.push(-1);
    },
    forward() {
      queue.push(1);
    },
    go(delta: number) {
      queue.push(delta);
    },
  };
  vi.spyOn(window, "history", "get").mockReturnValue(
    history as unknown as History,
  );
  const flush = () =>
    act(() => {
      let limit = 20;
      while (queue.length) {
        if (!limit--) throw Error("History did not converge");
        const target = index + queue.shift()!;
        if (target < 0 || target >= entries.length) continue;
        index = target;
        window.dispatchEvent(
          new PopStateEvent("popstate", { state: entries[index] }),
        );
      }
    });
  return { history, flush };
}
let navigation: ReturnType<typeof historyModel>;
beforeEach(() => {
  navigation = historyModel();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("DSEG license", {
          headers: { "Content-Type": "text/plain" },
        }),
    ),
  );
  vi.mocked(cache.loadDashboard).mockResolvedValue(null);
  vi.mocked(cache.saveDashboard).mockResolvedValue();
  vi.mocked(dashboardClient.fetchDashboard).mockResolvedValue(data);
  vi.mocked(weatherClient.fetchWeatherSettings).mockResolvedValue({
    revision: "r1",
    selection,
    canEdit: true,
    weather,
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
    settings: { revision: "r2", selection: { ...selection, station: "44133" } },
    weather: {
      ...weather,
      configurationRevision: "r2",
      temperatureStationLabel: "八王子",
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});
async function openWeather() {
  fireEvent.click(screen.getByRole("button", { name: "天気の地域を設定" }));
  await waitFor(() =>
    expect(screen.getByLabelText("気温の代表地点")).toBeEnabled(),
  );
}
function chooseStation(station = "44133") {
  fireEvent.change(screen.getByLabelText("気温の代表地点"), {
    target: { value: station },
  });
}
function closeSettings() {
  fireEvent.click(screen.getByRole("button", { name: "時計に戻る" }));
  navigation.flush();
}

it("opens clock/audio by default and directly opens weather from its shortcut", async () => {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  expect(screen.getByRole("heading", { name: "時計・音声" })).toHaveFocus();
  expect(
    screen.getByRole("navigation", { name: "設定の区分" }),
  ).toBeInTheDocument();
  closeSettings();
  expect(screen.getByRole("button", { name: "設定" })).toHaveFocus();
  await openWeather();
  expect(screen.getByRole("heading", { name: "天気・地域" })).toHaveFocus();
  expect(screen.queryByRole("button", { name: "戻る" })).toBeNull();
  closeSettings();
  expect(
    screen.getByRole("button", { name: "天気の地域を設定" }),
  ).toHaveFocus();
  act(() => navigation.history.forward());
  navigation.flush();
  expect(screen.getByRole("heading", { name: "天気・地域" })).toHaveFocus();
  expect(navigation.history.length).toBe(2);
});
it("keeps acknowledged weather embedded and uses the returned canonical revision and selection", async () => {
  render(<App />);
  await openWeather();
  chooseStation();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("保存しました"),
  );
  expect(
    screen.getByRole("heading", { name: "天気・地域" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("気温の代表地点")).toHaveValue("44133");
  expect(screen.getByText("八王子", { selector: "dd" })).toBeInTheDocument();
  chooseStation("44132");
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(weatherClient.saveWeatherSettings).toHaveBeenLastCalledWith({
      revision: "r2",
      selection,
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("保存しました"),
  );
  expect(cache.invalidateDashboardCache).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "RSS" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByRole("heading", { name: "RSS" })).toBeInTheDocument();
});
it("guards unsaved section changes, preserves input when canceled, and discards on confirmation", async () => {
  render(<App />);
  await openWeather();
  chooseStation();
  fireEvent.click(screen.getByRole("button", { name: "利用状況" }));
  expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "編集を続ける" }));
  expect(screen.getByLabelText("気温の代表地点")).toHaveValue("44133");
  fireEvent.click(screen.getByRole("button", { name: "利用状況" }));
  fireEvent.click(screen.getByRole("button", { name: "変更を破棄して移動" }));
  expect(screen.getByRole("heading", { name: "利用状況" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "天気・地域" }));
  await waitFor(() =>
    expect(screen.getByLabelText("気温の代表地点")).toHaveValue("44132"),
  );
  expect(weatherClient.saveWeatherSettings).not.toHaveBeenCalled();
});
it("resets an embedded draft on Cancel and derives dirtiness from canonical values", async () => {
  render(<App />);
  await openWeather();
  chooseStation();
  fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
  expect(
    screen.getByRole("heading", { name: "天気・地域" }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText("気温の代表地点")).toHaveValue("44132");
  chooseStation();
  chooseStation("44132");
  const enabled = screen.getByRole("checkbox", { name: "天気を表示する" });
  fireEvent.click(enabled);
  fireEvent.click(enabled);
  fireEvent.click(screen.getByRole("button", { name: "RSS" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByRole("heading", { name: "RSS" })).toBeInTheDocument();
});
it.each(["Escape", "header", "Back"])(
  "routes dirty %s dismissal through one shared confirmation",
  async (method) => {
    render(<App />);
    await openWeather();
    chooseStation();
    if (method === "Escape") fireEvent.keyDown(document, { key: "Escape" });
    else if (method === "header")
      fireEvent.click(screen.getByRole("button", { name: "設定" }));
    else {
      act(() => navigation.history.back());
      navigation.flush();
    }
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "編集を続ける" }));
    expect(screen.getByLabelText("気温の代表地点")).toHaveValue("44133");
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "変更を破棄して移動" }));
    navigation.flush();
    expect(screen.getByTestId("clock-time")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "天気の地域を設定" }),
    ).toHaveFocus();
    expect(navigation.history.length).toBe(2);
  },
);
it("blocks Back, Escape, header, update reload, and duplicate saves until acknowledgement", async () => {
  const worker = { postMessage: vi.fn() };
  vi.mocked(offline.prepareOffline).mockImplementation(
    async (_status, update) => update(worker as unknown as ServiceWorker),
  );
  let finish!: (
    value: Awaited<ReturnType<typeof weatherClient.saveWeatherSettings>>,
  ) => void;
  vi.mocked(weatherClient.saveWeatherSettings).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(<App />);
  await openWeather();
  chooseStation();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(screen.getByRole("button", { name: "設定" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "更新して再読み込み" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "時計に戻る" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "RSS" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "保存中…" }));
  fireEvent.keyDown(document, { key: "Escape" });
  act(() => navigation.history.back());
  navigation.flush();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(
    screen.getByRole("heading", { name: "天気・地域" }),
  ).toBeInTheDocument();
  expect(weatherClient.saveWeatherSettings).toHaveBeenCalledTimes(1);
  expect(worker.postMessage).not.toHaveBeenCalled();
  await act(async () =>
    finish({
      settings: {
        revision: "r2",
        selection: { ...selection, station: "44133" },
      },
      weather,
    }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("保存しました");
  closeSettings();
  expect(screen.getByTestId("clock-time")).toBeInTheDocument();
});
it("keeps weather viewers read-only without reading the admin catalog", async () => {
  vi.mocked(weatherClient.fetchWeatherSettings).mockResolvedValue({
    revision: "r1",
    selection,
    canEdit: false,
    weather,
  });
  render(<App />);
  await openWeatherReader();
  expect(
    screen.getByRole("heading", { name: "天気・地域" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(weatherClient.fetchWeatherOffices).not.toHaveBeenCalled();
  expect(weatherClient.fetchWeatherOffice).not.toHaveBeenCalled();
});
async function openWeatherReader() {
  fireEvent.click(screen.getByRole("button", { name: "天気の地域を設定" }));
  await screen.findByText(/この画面は現在の設定の確認のみ/);
}
it("collapses all-off usage and restores retained data and real timestamps without stopping refresh", async () => {
  const { container } = render(<App />);
  await screen.findByText("集約サービス接続済み");
  const original = container.querySelector(
    '[data-provider="claude"] .card-meta',
  )!.textContent;
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  fireEvent.click(screen.getByRole("button", { name: "利用状況" }));
  const checkboxes = screen.getAllByRole("checkbox");
  expect(checkboxes).toHaveLength(6);
  checkboxes.forEach((checkbox) => fireEvent.click(checkbox));
  closeSettings();
  expect(screen.queryByRole("region", { name: "AI利用状況" })).toBeNull();
  expect(container.querySelectorAll(".usage-card")).toHaveLength(0);
  expect(container.querySelector(".provider-layout")).toHaveClass(
    "usage-hidden",
  );
  expect(screen.getByTestId("clock-time")).toBeInTheDocument();
  expect(screen.getByText("フィード未登録")).toBeInTheDocument();
  const calls = vi.mocked(dashboardClient.fetchDashboard).mock.calls.length;
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(vi.mocked(dashboardClient.fetchDashboard).mock.calls.length).toBe(
    calls + 1,
  );
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  fireEvent.click(screen.getByRole("button", { name: "利用状況" }));
  expect(
    screen
      .getAllByRole("checkbox")
      .every((checkbox) => !(checkbox as HTMLInputElement).checked),
  ).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Claudeを表示する" }));
  closeSettings();
  const card = container.querySelector<HTMLElement>(
    '[data-provider="claude"]',
  )!;
  expect(
    within(card).getByText("37%", { selector: "strong" }),
  ).toBeInTheDocument();
  expect(card.querySelector(".card-meta")!.textContent).toBe(original);
  expect(container.querySelectorAll(".usage-card")).toHaveLength(1);
  expect(container.querySelector(".provider-layout")).not.toHaveClass(
    "usage-hidden",
  );
  expect(cache.invalidateDashboardCache).not.toHaveBeenCalled();
});
it("receives a newer successful response while all usage is hidden and reveals its real metadata before remount", async () => {
  const { container } = render(<App />);
  await screen.findByText("集約サービス接続済み");
  const originalMetadata = container.querySelector(
    '[data-provider="claude"] .card-meta',
  )!.textContent;
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  fireEvent.click(screen.getByRole("button", { name: "利用状況" }));
  screen
    .getAllByRole("checkbox")
    .forEach((checkbox) => fireEvent.click(checkbox));
  closeSettings();
  expect(container.querySelectorAll(".usage-card")).toHaveLength(0);

  const newer = {
    sourceObservedAt: "2026-10-03T12:35:00.000Z",
    capturedAt: "2026-10-03T12:36:00.000Z",
    receivedAt: "2026-10-03T12:37:00.000Z",
    lastSuccessAt: "2026-10-03T12:37:00.000Z",
  };
  const next: Dashboard = {
    ...data,
    usage: data.usage.map((value) => ({
      ...value,
      ...newer,
      buckets: value.buckets.map((bucket) => ({
        ...bucket,
        windows: bucket.windows.map((window) => ({
          ...window,
          usedPercent: 64,
        })),
      })),
    })),
  };
  const before = structuredClone(next);
  let finish!: (response: Dashboard) => void;
  vi.mocked(dashboardClient.fetchDashboard).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  act(() => window.dispatchEvent(new Event("online")));
  expect(container.querySelectorAll(".usage-card")).toHaveLength(0);
  await act(async () => finish(next));
  expect(container.querySelectorAll(".usage-card")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  fireEvent.click(screen.getByRole("button", { name: "利用状況" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Claudeを表示する" }));
  closeSettings();
  const card = container.querySelector<HTMLElement>(
    '[data-provider="claude"]',
  )!;
  expect(
    within(card).getByText("64%", { selector: "strong" }),
  ).toBeInTheDocument();
  const metadata = card.querySelector(".card-meta")!.textContent;
  expect(metadata).not.toBe(originalMetadata);
  for (const [label, timestamp] of [
    ["元データ観測", newer.sourceObservedAt],
    ["収集日時", newer.capturedAt],
    ["最終受信", newer.receivedAt],
    ["最終成功", newer.lastSuccessAt],
  ])
    expect(metadata).toContain(
      `${label} ${formatTime(timestamp, "Asia/Tokyo")}`,
    );
  expect(container.querySelectorAll(".usage-card")).toHaveLength(1);
  expect(next).toEqual(before);
  expect(cache.invalidateDashboardCache).not.toHaveBeenCalled();
});

it("warns when browser settings cannot be persisted but keeps the live choice", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("quota");
  });
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  fireEvent.click(screen.getByRole("button", { name: "利用状況" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Claudeを表示する" }));
  expect(screen.getByRole("alert")).toHaveTextContent("この画面では変更を維持");
  closeSettings();
  expect(document.querySelector('[data-provider="claude"]')).toBeNull();
});

it("keeps the 30-second poll mounted while every usage provider is hidden", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  localStorage.setItem(
    "fire-dashboard-settings-v1",
    JSON.stringify({
      usageVisibility: Object.fromEntries(
        Object.keys(defaultUsageVisibility).map((provider) => [
          provider,
          false,
        ]),
      ),
    }),
  );
  const before = structuredClone(data);
  render(<App />);
  await screen.findByText("集約サービス接続済み");
  expect(screen.queryByRole("region", { name: "AI利用状況" })).toBeNull();
  expect(dashboardClient.fetchDashboard).toHaveBeenCalledTimes(1);
  vi.mocked(dashboardClient.fetchDashboard).mockRejectedValueOnce(
    Error("network"),
  );
  await act(async () => vi.advanceTimersByTime(29999));
  expect(dashboardClient.fetchDashboard).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTime(1));
  expect(screen.getByText("集約サービスに未接続")).toBeInTheDocument();
  expect(dashboardClient.fetchDashboard).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  fireEvent.click(screen.getByRole("button", { name: "利用状況" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Claudeを表示する" }));
  closeSettings();
  const card = document.querySelector<HTMLElement>('[data-provider="claude"]')!;
  expect(
    within(card).getByText("37%", { selector: "strong" }),
  ).toBeInTheDocument();
  expect(data).toEqual(before);
  expect(vi.mocked(cache.saveDashboard).mock.calls.at(-1)?.[0].usage).toEqual(
    before.usage,
  );
});
