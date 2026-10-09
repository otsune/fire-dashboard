// @vitest-environment jsdom
import React from "react";
import { it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  emptyDashboard,
  emptyCommon,
} from "../../packages/contracts/src/index";
import { WeatherCard } from "../../apps/dashboard/src/cards/WeatherCard";
import { UsageCard } from "../../apps/dashboard/src/cards/UsageCard";
import { RssCard } from "../../apps/dashboard/src/cards/RssCard";
import { deriveStatus, formatTime } from "../../apps/dashboard/src/data/status";
afterEach(cleanup);
const now = Date.parse("2026-10-02T00:00:00Z");
it("makes missing weather region explicit", () => {
  render(
    <WeatherCard
      value={emptyDashboard().weather}
      timeZone="Asia/Tokyo"
      now={now}
    />,
  );
  expect(screen.getByText("地域未設定")).toBeInTheDocument();
});
it("retains complete weather names and forecasts in openable details", async () => {
  const regionLabel =
    "東京地方・多摩西部・伊豆諸島北部を含む長い予報地域の表示確認".repeat(3);
  const stationLabel =
    "山間部と離島を含む非常に長い気温代表地点の表示確認".repeat(3);
  const periods = Array.from({ length: 4 }, (_, index) => ({
    startsAt: new Date(now + index * 3_600_000).toISOString(),
    endsAt: new Date(now + (index + 1) * 3_600_000).toISOString(),
    summary:
      index === 0
        ? "晴れ時々くもり。昼過ぎから雨で、所により雷を伴い激しく降る。".repeat(
            12,
          )
        : `予報 ${index + 1}`,
    weatherCode: null,
    temperatureMinC: 19,
    temperatureMaxC: 27,
    precipitationProbabilityPct: 20,
  }));
  const { container } = render(
    <WeatherCard
      value={{
        ...emptyDashboard().weather,
        regionId: "130010",
        regionLabel,
        temperatureStationLabel: stationLabel,
        periods,
      }}
      timeZone="UTC"
      now={now}
    />,
  );
  expect(screen.getByRole("heading", { name: regionLabel })).toHaveTextContent(
    regionLabel,
  );
  expect(
    container.querySelector(".weather-card > .forecast strong"),
  ).toHaveTextContent(periods[0].summary);
  expect(
    container.querySelector(".weather-card > .forecast"),
  ).toHaveTextContent("予報気温 19〜27 °C · 降水 20%");
  const details = container.querySelector("details")!;
  const summary = details.querySelector("summary")!;
  const user = userEvent.setup();
  expect(details).not.toHaveAttribute("open");
  await user.click(summary);
  expect(details).toHaveAttribute("open");
  expect(
    within(details).getByText(`予報地方：${regionLabel}`, { exact: true }),
  ).toBeVisible();
  expect(
    within(details).getByText(`気温地点：${stationLabel}`, { exact: true }),
  ).toBeVisible();
  const detailedForecasts = details.querySelectorAll<HTMLElement>(".forecast");
  expect(detailedForecasts).toHaveLength(periods.length);
  for (const [index, period] of periods.entries()) {
    expect(
      within(details).getByText(period.summary, { exact: true }),
    ).toBeVisible();
    expect(detailedForecasts[index]).toHaveTextContent(
      `${formatTime(period.startsAt, "UTC")}〜${formatTime(period.endsAt, "UTC")}`,
    );
    expect(detailedForecasts[index]).toHaveTextContent(
      "予報気温 19〜27 °C · 降水 20%",
    );
  }
  await user.click(
    within(details).getByRole("button", { name: "詳細を閉じる" }),
  );
  expect(details).not.toHaveAttribute("open");
  expect(summary).toHaveFocus();
});
it.each([true, false])(
  "groups weather actions while retaining details with setup available=%s",
  async (withSettings) => {
    let settingsOpened = 0;
    const { container } = render(
      <WeatherCard
        value={emptyDashboard().weather}
        timeZone="UTC"
        now={now}
        onWeatherSettings={withSettings ? () => settingsOpened++ : undefined}
      />,
    );
    // This is a DOM grouping/interaction check, not a layout measurement.
    const actions =
      container.querySelector<HTMLDivElement>(".weather-actions")!;
    expect(actions).not.toBeNull();
    const details = actions.querySelector("details")!;
    const summary = details.querySelector("summary")!;
    const user = userEvent.setup();
    if (withSettings) {
      await user.click(
        within(actions).getByRole("button", { name: "天気の地域を設定" }),
      );
      expect(settingsOpened).toBe(1);
    } else {
      expect(
        within(actions).queryByRole("button", { name: "天気の地域を設定" }),
      ).toBeNull();
    }
    await user.click(summary);
    expect(details).toHaveAttribute("open");
    expect(
      within(details).getByText(/予報地方と気温の代表地点を選択/),
    ).toBeVisible();
    await user.click(
      within(details).getByRole("button", { name: "詳細を閉じる" }),
    );
    expect(details).not.toHaveAttribute("open");
    expect(summary).toHaveFocus();
  },
);
it("shows an empty feed without fixture headlines", () => {
  render(
    <RssCard feeds={[]} autoRotate={false} timeZone="Asia/Tokyo" now={now} />,
  );
  expect(screen.getByText("フィード未登録")).toBeInTheDocument();
});
it("never displays a percentage bar for missing rate", () => {
  render(
    <UsageCard
      value={{
        ...emptyDashboard().usage[0],
        ...emptyCommon("ok"),
        buckets: [
          {
            id: "a",
            label: "a",
            windows: [
              {
                id: "w",
                label: "5時間",
                usedPercent: null,
                windowMinutes: 300,
                resetsAt: null,
              },
            ],
          },
        ],
      }}
      timeZone="UTC"
      now={now}
    />,
  );
  expect(screen.queryByRole("progressbar")).toBeNull();
  // Providers that never report an observation time are not flagged stale.
  expect(screen.getByText("受信済み")).toBeInTheDocument();
});
it("keeps an explicit stale status even without an observation time", () => {
  const fresh = new Date(now).toISOString();
  const stale = {
    ...emptyDashboard().usage[0],
    ...emptyCommon("stale"),
    receivedAt: fresh,
    sourceObservedAt: null,
  };
  expect(deriveStatus(stale, now)).toEqual({ label: "更新遅延", stale: true });
  // Also when previous usage is retained alongside the stale status.
  expect(
    deriveStatus(
      {
        ...stale,
        lastSuccessAt: fresh,
        buckets: [
          {
            id: "rate_limits",
            label: "利用上限",
            windows: [
              {
                id: "five_hour",
                label: "5時間",
                usedPercent: 40,
                windowMinutes: 300,
                resetsAt: new Date(now + 3600000).toISOString(),
              },
            ],
          },
        ],
      },
      now,
    ),
  ).toEqual({ label: "更新遅延", stale: true });
  // An ok value without an observation time is still shown as received.
  expect(deriveStatus({ ...stale, status: "ok" }, now)).toEqual({
    label: "受信済み",
    stale: false,
  });
});
it("distinguishes source disconnect, observation age and clock skew", () => {
  const u = {
    ...emptyDashboard().usage[0],
    ...emptyCommon("ok"),
    receivedAt: "2026-10-01T23:54:59.000Z",
  };
  expect(deriveStatus(u, now).label).toBe("取得元に未接続");
  expect(
    deriveStatus({ ...u, receivedAt: "2026-10-02T00:01:00.000Z" }, now).label,
  ).toBe("時刻要確認");
  expect(
    deriveStatus(
      {
        ...u,
        receivedAt: new Date(now).toISOString(),
        sourceObservedAt: "2026-10-01T23:54:59.000Z",
        freshness: "known",
      },
      now,
    ).label,
  ).toBe("更新遅延");
});
it("never resets a percentage itself", () => {
  const u = {
    ...emptyDashboard().usage[0],
    ...emptyCommon("ok"),
    receivedAt: new Date(now).toISOString(),
    buckets: [
      {
        id: "a",
        label: "a",
        windows: [
          {
            id: "x",
            label: "x",
            usedPercent: 80,
            windowMinutes: 30,
            resetsAt: "2026-10-01T23:59:00.000Z",
          },
        ],
      },
    ],
  };
  expect(deriveStatus(u, now).label).toBe("更新待ち");
  render(<UsageCard value={u} timeZone="UTC" now={now} />);
  expect(screen.getByText("80%")).toBeInTheDocument();
});
it("removes expired forecast periods and flags old RSS", () => {
  const w = {
    ...emptyDashboard().weather,
    ...emptyCommon("ok"),
    regionLabel: "テスト地域",
    periods: [
      {
        startsAt: "2026-10-01T00:00:00.000Z",
        endsAt: "2026-10-01T06:00:00.000Z",
        summary: "期限切れ晴れ",
        weatherCode: null,
        temperatureMinC: null,
        temperatureMaxC: null,
        precipitationProbabilityPct: null,
      },
    ],
  };
  render(<WeatherCard value={w} timeZone="UTC" now={now} />);
  expect(screen.queryByText("期限切れ晴れ")).toBeNull();
  expect(
    deriveStatus(
      {
        ...emptyCommon("ok"),
        id: "f",
        label: "f",
        items: [],
        lastSuccessAt: "2026-10-01T17:59:00.000Z",
      },
      now,
    ).label,
  ).toBe("更新遅延");
});
