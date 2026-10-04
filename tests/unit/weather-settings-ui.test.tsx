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
import {
  emptyWeather,
  type WeatherOffice,
  type WeatherSettingsView,
} from "../../packages/contracts/src/index";
import { WeatherSettings } from "../../apps/dashboard/src/settings/WeatherSettings";
import * as client from "../../apps/dashboard/src/data/weather-settings";
vi.mock(
  "../../apps/dashboard/src/data/weather-settings",
  async (importOriginal) => {
    const actual = await importOriginal<typeof client>();
    return {
      ...actual,
      fetchWeatherSettings: vi.fn(),
      fetchWeatherOffices: vi.fn(),
      fetchWeatherOffice: vi.fn(),
      saveWeatherSettings: vi.fn(),
    };
  },
);
const selection = { office: "130000", region: "130010", station: "44132" };
const view = (canEdit = true): WeatherSettingsView => ({
  revision: "r1",
  selection,
  canEdit,
  weather: {
    ...emptyWeather(),
    configurationRevision: "r1",
    status: "missing",
    regionId: "130010",
    regionLabel: "東京地方",
    temperatureStationLabel: "東京",
  },
});
const office: WeatherOffice = {
  office: { id: "130000", label: "東京都" },
  regions: [{ id: "130010", label: "東京地方" }],
  stations: [
    { id: "44132", label: "東京" },
    { id: "44133", label: "八王子" },
  ],
};
beforeEach(() => {
  vi.mocked(client.fetchWeatherSettings).mockResolvedValue(view());
  vi.mocked(client.fetchWeatherOffices).mockResolvedValue({
    offices: [
      office.office,
      { id: "140000", label: "神奈川県" },
      { id: "150000", label: "新潟県" },
    ],
  });
  vi.mocked(client.fetchWeatherOffice).mockResolvedValue(office);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
async function setup() {
  const onClose = vi.fn(),
    onSaved = vi.fn();
  render(<WeatherSettings onClose={onClose} onSaved={onSaved} />);
  await waitFor(() => expect(screen.getByLabelText("予報地方")).toBeEnabled());
  return { onClose, onSaved };
}
it("loads the current server state, native selectors and keyboard focus", async () => {
  let release!: (value: WeatherSettingsView) => void;
  vi.mocked(client.fetchWeatherSettings).mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  render(<WeatherSettings onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.getByRole("status")).toHaveTextContent("読み込み中");
  expect(screen.getByRole("heading", { name: "天気の地域設定" })).toHaveFocus();
  await act(async () => release(view()));
  expect(await screen.findByLabelText("予報地方")).toHaveValue("130010");
  expect(screen.getAllByRole("combobox")).toHaveLength(3);
});
it("shows canonical labels to readers without reading the admin catalog or offering save", async () => {
  vi.mocked(client.fetchWeatherSettings).mockResolvedValue(view(false));
  render(<WeatherSettings onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(await screen.findByText(/変更には管理者権限/)).toBeInTheDocument();
  expect(screen.getByText("東京地方")).toBeInTheDocument();
  expect(screen.getByText("東京", { exact: true })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(client.fetchWeatherOffices).not.toHaveBeenCalled();
});
it("clears dependent choices on office change and ignores a late old catalog", async () => {
  await setup();
  let old!: (value: WeatherOffice) => void,
    latest!: (value: WeatherOffice) => void;
  vi.mocked(client.fetchWeatherOffice).mockImplementation(
    (id) =>
      new Promise((resolve) => {
        if (id === "140000") old = resolve;
        else latest = resolve;
      }),
  );
  fireEvent.change(screen.getByLabelText("都道府県・予報官署"), {
    target: { value: "140000" },
  });
  expect(screen.getByLabelText("予報地方")).toHaveValue("");
  expect(screen.getByLabelText("気温の代表地点")).toHaveValue("");
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("都道府県・予報官署"), {
    target: { value: "150000" },
  });
  await act(async () =>
    latest({
      office: { id: "150000", label: "新潟県" },
      regions: [{ id: "150010", label: "下越" }],
      stations: [{ id: "54232", label: "新潟" }],
    }),
  );
  await act(async () =>
    old({ ...office, office: { id: "140000", label: "神奈川県" } }),
  );
  expect(screen.getByRole("option", { name: "下越" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "東京地方" })).toBeNull();
});
it("saves the explicit station with acknowledged Weather, and blocks duplicate/dismissal while pending", async () => {
  const { onClose, onSaved } = await setup();
  let finish!: (
    value: Awaited<ReturnType<typeof client.saveWeatherSettings>>,
  ) => void;
  vi.mocked(client.saveWeatherSettings).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  fireEvent.change(screen.getByLabelText("気温の代表地点"), {
    target: { value: "44133" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  fireEvent.click(screen.getByRole("button", { name: "保存中…" }));
  fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "戻る" })).toBeDisabled();
  expect(client.saveWeatherSettings).toHaveBeenCalledTimes(1);
  expect(client.saveWeatherSettings).toHaveBeenCalledWith({
    revision: "r1",
    selection: { ...selection, station: "44133" },
  });
  const weather = {
    ...view().weather,
    configurationRevision: "r2",
    temperatureStationLabel: "八王子",
    periods: [],
  };
  await act(async () =>
    finish({ settings: { revision: "r2", selection }, weather }),
  );
  expect(onSaved).toHaveBeenCalledWith(weather);
  expect(onClose).toHaveBeenCalledTimes(1);
});
it("discards changes through Cancel/Back/Escape and reloads canonical state on reopen", async () => {
  const { onClose } = await setup();
  fireEvent.change(screen.getByLabelText("気温の代表地点"), {
    target: { value: "44133" },
  });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  cleanup();
  const reopened = await setup();
  expect(screen.getByLabelText("気温の代表地点")).toHaveValue("44132");
  fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
  fireEvent.click(screen.getByRole("button", { name: "戻る" }));
  expect(reopened.onClose).toHaveBeenCalledTimes(2);
  expect(client.saveWeatherSettings).not.toHaveBeenCalled();
});
it("requires explicit reload after revision conflict rather than overwriting another selection", async () => {
  const { onSaved } = await setup();
  vi.mocked(client.saveWeatherSettings).mockRejectedValueOnce(
    new client.WeatherSettingsError("revision_conflict"),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("別の画面");
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  expect(onSaved).not.toHaveBeenCalled();
  vi.mocked(client.fetchWeatherSettings).mockResolvedValue({
    ...view(),
    revision: "r2",
    selection: { ...selection, station: "44133" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "現在の設定を再読み込み" }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("気温の代表地点")).toHaveValue("44133"),
  );
});
it("explains uncertain save acknowledgement and requires reload before retry", async () => {
  const { onSaved } = await setup();
  vi.mocked(client.saveWeatherSettings).mockRejectedValueOnce(
    new client.WeatherSettingsError("timeout", true),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "保存された可能性",
  );
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  expect(onSaved).not.toHaveBeenCalled();
});
it.each(["forbidden", "service_unavailable"])(
  "keeps the draft on definitive save error %s",
  async (code) => {
    await setup();
    fireEvent.change(screen.getByLabelText("気温の代表地点"), {
      target: { value: "44133" },
    });
    vi.mocked(client.saveWeatherSettings).mockRejectedValueOnce(
      new client.WeatherSettingsError(code),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("気温の代表地点")).toHaveValue("44133");
  },
);
it("makes a failed catalog retryable without discarding the draft", async () => {
  vi.mocked(client.fetchWeatherOffice).mockRejectedValueOnce(
    new client.WeatherSettingsError("network"),
  );
  render(<WeatherSettings onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("候補");
  fireEvent.click(screen.getByRole("button", { name: "候補を再読み込み" }));
  await waitFor(() =>
    expect(screen.getByLabelText("気温の代表地点")).toBeEnabled(),
  );
  expect(screen.getByLabelText("気温の代表地点")).toHaveValue("44132");
});
it("saves disabled weather as an explicit null selection", async () => {
  const { onSaved } = await setup();
  const weather = { ...emptyWeather(), configurationRevision: "r2" };
  vi.mocked(client.saveWeatherSettings).mockResolvedValueOnce({
    settings: { revision: "r2", selection: null },
    weather,
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "天気を表示する" }));
  expect(screen.getByLabelText("予報地方")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(weather));
  expect(client.saveWeatherSettings).toHaveBeenCalledWith({
    revision: "r1",
    selection: null,
  });
});
it("provides retry after offline loading failure without offering a false save", async () => {
  vi.mocked(client.fetchWeatherSettings).mockRejectedValueOnce(
    new client.WeatherSettingsError("network"),
  );
  render(<WeatherSettings onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "現在の設定を再読み込み" }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("気温の代表地点")).toBeEnabled(),
  );
});
it("falls back to explicit IDs when canonical labels are absent", async () => {
  vi.mocked(client.fetchWeatherSettings).mockResolvedValue({
    ...view(false),
    weather: {
      ...view(false).weather,
      regionLabel: null,
      temperatureStationLabel: null,
    },
  });
  render(<WeatherSettings onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(
    await screen.findByText("130010", { exact: true }),
  ).toBeInTheDocument();
  expect(screen.getByText("44132", { exact: true })).toBeInTheDocument();
});
it("keeps office-list failure retryable after weather is toggled off and on", async () => {
  vi.mocked(client.fetchWeatherOffices).mockRejectedValueOnce(
    new client.WeatherSettingsError("network"),
  );
  render(<WeatherSettings onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("候補");
  const enabled = screen.getByRole("checkbox", { name: "天気を表示する" });
  fireEvent.click(enabled);
  fireEvent.click(enabled);
  await waitFor(() =>
    expect(screen.getByLabelText("気温の代表地点")).toBeEnabled(),
  );
  expect(screen.getByLabelText("都道府県・予報官署")).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "候補を再読み込み" }),
  ).toBeInTheDocument();
  expect(screen.queryByText("地域の候補を読み込み中…")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "候補を再読み込み" }));
  await waitFor(() =>
    expect(screen.getByLabelText("都道府県・予報官署")).toBeEnabled(),
  );
  expect(screen.getByLabelText("気温の代表地点")).toHaveValue("44132");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("reports an embedded canonical dirty/saving guard and resets draft without closing", async () => {
  const onClose = vi.fn(),
    onGuardChange = vi.fn();
  render(
    <WeatherSettings
      embedded
      onGuardChange={onGuardChange}
      onClose={onClose}
      onSaved={vi.fn()}
    />,
  );
  await waitFor(() => expect(screen.getByLabelText("予報地方")).toBeEnabled());
  expect(onGuardChange).toHaveBeenLastCalledWith({
    dirty: false,
    saving: false,
  });
  fireEvent.change(screen.getByLabelText("気温の代表地点"), {
    target: { value: "44133" },
  });
  expect(onGuardChange).toHaveBeenLastCalledWith({
    dirty: true,
    saving: false,
  });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
  expect(screen.getByLabelText("気温の代表地点")).toHaveValue("44132");
  expect(onGuardChange).toHaveBeenLastCalledWith({
    dirty: false,
    saving: false,
  });
  expect(onClose).not.toHaveBeenCalled();
  let finish!: (
    value: Awaited<ReturnType<typeof client.saveWeatherSettings>>,
  ) => void;
  vi.mocked(client.saveWeatherSettings).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  fireEvent.change(screen.getByLabelText("気温の代表地点"), {
    target: { value: "44133" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(onGuardChange).toHaveBeenLastCalledWith({ dirty: true, saving: true });
  await act(async () =>
    finish({
      settings: {
        revision: "r2",
        selection: { ...selection, station: "44133" },
      },
      weather: view().weather,
    }),
  );
  expect(onGuardChange).toHaveBeenLastCalledWith({
    dirty: false,
    saving: false,
  });
  expect(screen.getByRole("status")).toHaveTextContent("保存しました");
  expect(onClose).not.toHaveBeenCalled();
});
it("adopts the server's canonical response even when it differs from the submitted draft", async () => {
  const onGuardChange = vi.fn();
  vi.mocked(client.saveWeatherSettings).mockResolvedValueOnce({
    settings: { revision: "r2", selection: null },
    weather: emptyWeather(),
  });
  render(
    <WeatherSettings
      embedded
      onGuardChange={onGuardChange}
      onClose={vi.fn()}
      onSaved={vi.fn()}
    />,
  );
  await waitFor(() => expect(screen.getByLabelText("予報地方")).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("保存しました");
  expect(
    screen.getByRole("checkbox", { name: "天気を表示する" }),
  ).not.toBeChecked();
  expect(screen.getByLabelText("都道府県・予報官署")).toHaveValue("");
  expect(onGuardChange).toHaveBeenLastCalledWith({
    dirty: false,
    saving: false,
  });
});
it("requires explicit reload after 403 and respects read-only permissions returned by that reload", async () => {
  await setup();
  vi.mocked(client.saveWeatherSettings).mockRejectedValueOnce(
    new client.WeatherSettingsError("forbidden"),
  );
  fireEvent.change(screen.getByLabelText("気温の代表地点"), {
    target: { value: "44133" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("管理者権限");
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(client.saveWeatherSettings).toHaveBeenCalledTimes(1);
  const catalogReads = vi.mocked(client.fetchWeatherOffices).mock.calls.length;
  vi.mocked(client.fetchWeatherSettings).mockResolvedValue(view(false));
  fireEvent.click(
    screen.getByRole("button", { name: "現在の設定を再読み込み" }),
  );
  await screen.findByText(/この画面は現在の設定の確認のみ/);
  expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  expect(client.fetchWeatherOffices).toHaveBeenCalledTimes(catalogReads);
});
it("treats an unknown save failure as unconfirmed until explicit server reload", async () => {
  await setup();
  vi.mocked(client.saveWeatherSettings).mockRejectedValueOnce(
    Error("unrecognized"),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "保存された可能性",
  );
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "現在の設定を再読み込み" }),
  ).toBeEnabled();
});

it("clears a previous Saved result as soon as another embedded save starts", async () => {
  vi.mocked(client.saveWeatherSettings).mockResolvedValueOnce({
    settings: { revision: "r2", selection },
    weather: view().weather,
  });
  render(<WeatherSettings embedded onClose={vi.fn()} onSaved={vi.fn()} />);
  await waitFor(() => expect(screen.getByLabelText("予報地方")).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("保存しました");
  vi.mocked(client.saveWeatherSettings).mockReturnValueOnce(
    new Promise(() => {}),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(screen.queryByText("保存しました")).toBeNull();
});

it.each(["forbidden", "revision_conflict", "unknown"])(
  "keeps the %s reload barrier through embedded Cancel and resends only with reloaded revision",
  async (code) => {
    render(<WeatherSettings embedded onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByLabelText("予報地方")).toBeEnabled(),
    );
    vi.mocked(client.saveWeatherSettings).mockRejectedValueOnce(
      code === "unknown"
        ? Error("unconfirmed")
        : new client.WeatherSettingsError(code),
    );
    fireEvent.change(screen.getByLabelText("気温の代表地点"), {
      target: { value: "44133" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(screen.getByLabelText("気温の代表地点")).toHaveValue("44132");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(client.saveWeatherSettings).toHaveBeenCalledTimes(1);
    vi.mocked(client.fetchWeatherSettings).mockResolvedValue({
      ...view(),
      revision: "r7",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "現在の設定を再読み込み" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存" })).toBeEnabled(),
    );
    vi.mocked(client.saveWeatherSettings).mockResolvedValue({
      settings: { revision: "r8", selection },
      weather: view().weather,
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("保存しました");
    expect(client.saveWeatherSettings).toHaveBeenLastCalledWith({
      revision: "r7",
      selection,
    });
  },
);
