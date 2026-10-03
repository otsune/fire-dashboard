// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { emptyUsage, type Usage } from "../../packages/contracts/src/index";
import { UsageCard } from "../../apps/dashboard/src/cards/UsageCard";

const now = Date.parse("2026-10-02T00:00:00Z");
afterEach(cleanup);

function quota(fields: Partial<Usage> = {}): Usage {
  return {
    ...emptyUsage("claude"),
    status: "ok",
    receivedAt: new Date(now).toISOString(),
    sourceObservedAt: new Date(now).toISOString(),
    sourceAlias: "desk-pc",
    buckets: [
      {
        id: "all",
        label: "全モデル",
        windows: [
          {
            id: "session",
            label: "セッション",
            usedPercent: 25,
            windowMinutes: 300,
            resetsAt: "2026-10-02T02:30:00Z",
          },
          {
            id: "week",
            label: "週間",
            usedPercent: 60,
            windowMinutes: 10080,
            resetsAt: "2026-10-04T00:00:00Z",
          },
          {
            id: "extra",
            label: "追加枠",
            usedPercent: 80,
            windowMinutes: null,
            resetsAt: null,
          },
        ],
      },
    ],
    ...fields,
  };
}

it("keeps only two quota windows on the compact face and reveals remaining data on tap", () => {
  const { container } = render(
    <UsageCard value={quota()} timeZone="UTC" now={now} />,
  );
  const overview = container.querySelector(".usage-overview") as HTMLElement;
  expect(overview).not.toBeNull();
  expect(within(overview).getAllByRole("progressbar")).toHaveLength(2);
  expect(within(overview).getByText("25%")).toBeVisible();
  expect(within(overview).getByText("60%")).toBeVisible();
  expect(within(overview).queryByText("追加枠")).toBeNull();
  const details = container.querySelector("details")!;
  expect(details).not.toHaveAttribute("open");
  expect(within(details).getByText("追加枠")).not.toBeVisible();
  expect(screen.getByText("desk-pc")).not.toBeVisible();
  fireEvent.click(within(details).getByText("詳細"));
  expect(details).toHaveAttribute("open");
  expect(within(details).getByText("追加枠")).toBeVisible();
  expect(within(details).getByText("使用率 80%")).toBeVisible();
  expect(screen.getByText("desk-pc")).toBeVisible();
  expect(within(details).getByText(/最終受信/)).toBeVisible();
});

it("shows short relative reset times on the card while keeping absolute times in detail", () => {
  const { container } = render(
    <UsageCard value={quota()} timeZone="UTC" now={now} />,
  );
  const overview = container.querySelector(".usage-overview") as HTMLElement;
  expect(overview).not.toBeNull();
  expect(within(overview).getByText("リセットまで 2時間30分")).toBeVisible();
  expect(within(overview).getByText("リセットまで 2日")).toBeVisible();
  expect(within(overview).queryByText(/10\/2/)).toBeNull();
  expect(
    within(container.querySelector("details")!).getByText(
      "リセット予定 10/2 02:30",
    ),
  ).toBeInTheDocument();
});

it.each(["claude", "codex", "antigravity", "opencode_go"] as const)(
  "preserves %s zero, missing, and elapsed quota semantics on the compact face",
  (provider) => {
    const value = quota({ provider });
    value.buckets[0].windows = [
      {
        id: "zero",
        label: "ゼロ枠",
        usedPercent: 0,
        windowMinutes: 300,
        resetsAt: "2026-10-01T23:59:00Z",
      },
      {
        id: "missing",
        label: "不明枠",
        usedPercent: null,
        windowMinutes: null,
        resetsAt: null,
      },
    ];
    const { container } = render(
      <UsageCard value={value} timeZone="UTC" now={now} />,
    );
    const overview = container.querySelector(".usage-overview") as HTMLElement;
    expect(overview).not.toBeNull();
    expect(within(overview).getAllByRole("progressbar")).toHaveLength(1);
    expect(within(overview).getByRole("progressbar")).toHaveAttribute(
      "value",
      "0",
    );
    expect(within(overview).getByText("0%")).toBeVisible();
    expect(within(overview).getByText("未取得")).toBeVisible();
    expect(within(overview).getByText("リセット後・更新待ち")).toBeVisible();
    expect(within(overview).getByText("リセット時刻不明")).toBeVisible();
    expect(screen.getByText("更新待ち")).toBeVisible();
  },
);

it("uses the Nous total USD balance as the main figure and keeps the breakdown in detail", () => {
  const value = quota({
    provider: "hermes_nous",
    buckets: [],
    balance: {
      currency: "USD",
      totalRemaining: 37,
      subscriptionRemaining: 25,
      purchasedRemaining: 12,
      monthlyAllowance: 20,
      renewsAt: "2026-10-05T00:00:00Z",
    },
  });
  const { container } = render(
    <UsageCard value={value} timeZone="UTC" now={now} />,
  );
  const overview = container.querySelector(".usage-overview") as HTMLElement;
  expect(overview).not.toBeNull();
  expect(within(overview).getByText("$37.00")).toBeVisible();
  expect(within(overview).getByText("USD 合計残高")).toBeVisible();
  expect(within(overview).getByText("更新まで 3日")).toBeVisible();
  expect(within(overview).queryByText("プラン残高")).toBeNull();
  expect(screen.getByText("プラン残高")).not.toBeVisible();
  expect(container.querySelector("progress")).toBeNull();
  expect(overview.textContent).not.toContain("%");
});

it("keeps an acquisition error visible alongside the retained compact quota", () => {
  const { container } = render(
    <UsageCard
      value={quota({ status: "error", errorCode: "auth" })}
      timeZone="UTC"
      now={now}
    />,
  );
  expect(screen.getByText("認証を確認")).toBeVisible();
  expect(container.querySelector(".usage-card")).toHaveAttribute(
    "data-stale",
    "true",
  );
  expect(
    within(container.querySelector(".usage-overview") as HTMLElement).getByText(
      "25%",
    ),
  ).toBeVisible();
});

it("closes the detail panel with its own button and returns focus to the summary", () => {
  const { container } = render(
    <UsageCard value={quota()} timeZone="UTC" now={now} />,
  );
  const details = container.querySelector("details")!;
  const summary = details.querySelector("summary")!;
  fireEvent.click(summary);
  expect(details).toHaveAttribute("open");
  fireEvent.click(screen.getByRole("button", { name: "詳細を閉じる" }));
  expect(details).not.toHaveAttribute("open");
  expect(summary).toHaveFocus();
});

it("keeps the unavailable primary value explicit with no invented quota", () => {
  const { container } = render(
    <UsageCard value={emptyUsage("codex")} timeZone="UTC" now={now} />,
  );
  const main = container.querySelector(".usage-overview .usage-value");
  expect(main).not.toBeNull();
  expect(main).toHaveTextContent("—");
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByText("収集処理が未設定です")).toBeVisible();
});
