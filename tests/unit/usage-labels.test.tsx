// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { emptyUsage, type Usage } from "../../packages/contracts/src/index";
import { UsageCard } from "../../apps/dashboard/src/cards/UsageCard";

const now = Date.parse("2026-10-02T00:00:00Z");
afterEach(cleanup);

function quota(
  windowMinutes: number | null,
  fields: Partial<Usage> = {},
): Usage {
  return {
    ...emptyUsage("codex"),
    status: "ok",
    receivedAt: new Date(now).toISOString(),
    buckets: [
      {
        id: "codex",
        label: "Codex",
        windows: [
          {
            id: "primary",
            label: "基本枠",
            usedPercent: 25,
            windowMinutes,
            resetsAt: "2026-10-02T02:30:00Z",
          },
        ],
      },
    ],
    ...fields,
  };
}

function renderQuota(value: Usage) {
  const { container } = render(
    <UsageCard value={value} timeZone="UTC" now={now} />,
  );
  return {
    overview: within(container.querySelector(".usage-overview") as HTMLElement),
    details: within(container.querySelector("details")!),
  };
}

it.each<[number, string]>([
  [300, "5時間"],
  [10080, "7日間"],
  [1440, "1日間"],
  [45, "45分"],
  [90, "1時間30分"],
  [1501, "1日1時間1分"],
])("labels a known %i-minute quota by its actual period", (minutes, label) => {
  const { overview } = renderQuota(quota(minutes));
  expect(overview.getByText(label)).toBeVisible();
  expect(overview.queryByText("基本枠")).toBeNull();
  expect(overview.getByText("リセットまで 2時間30分")).toBeVisible();
});

it("keeps an unknown period's supplied name without inferring it from reset time", () => {
  const { overview } = renderQuota(quota(null));
  expect(overview.getByText("基本枠")).toBeVisible();
  expect(overview.queryByText("2時間30分")).toBeNull();
  expect(overview.getByText("リセットまで 2時間30分")).toBeVisible();
});

it("preserves the meaningful name of Antigravity's single weekly bucket", () => {
  const value = quota(null, { provider: "antigravity" });
  value.buckets[0].label = "Gemini 週間枠";
  value.buckets[0].windows[0].label = "利用枠";
  const { overview } = renderQuota(value);
  expect(overview.getByText("Gemini 週間枠 · 利用枠")).toBeVisible();
});

it("preserves a meaningful single bucket alongside a known period", () => {
  const value = quota(300, { provider: "claude" });
  value.buckets[0].label = "全モデル";
  value.buckets[0].windows[0].label = "セッション";
  const { overview } = renderQuota(value);
  expect(overview.getByText("全モデル · 5時間")).toBeVisible();
});

it.each(["Codex", "codex", "利用上限"])(
  "omits only the redundant single-bucket name %s",
  (bucketLabel) => {
    const value = quota(300);
    value.buckets[0].label = bucketLabel;
    const { overview } = renderQuota(value);
    expect(overview.getByText("5時間")).toBeVisible();
    expect(overview.queryByText(`${bucketLabel} · 5時間`)).toBeNull();
  },
);

it("preserves distinct bucket identities when their quota periods match", () => {
  const value = quota(300);
  value.buckets = [
    { ...value.buckets[0], id: "model", label: "GPT-5.4" },
    { ...value.buckets[0], id: "review", label: "コードレビュー" },
  ];
  const { overview } = renderQuota(value);
  expect(overview.getByText("GPT-5.4 · 5時間")).toBeVisible();
  expect(overview.getByText("コードレビュー · 5時間")).toBeVisible();
});

it("keeps original bucket and window names in the title, accessible name, and detail", () => {
  const { overview, details } = renderQuota(quota(10080));
  expect(overview.getByText("7日間")).toHaveAttribute(
    "title",
    "Codex · 基本枠",
  );
  expect(
    overview.getByRole("progressbar", { name: "Codex 基本枠 使用率" }),
  ).toBeVisible();
  expect(
    details.getByRole("heading", { name: "Codex", hidden: true }),
  ).toBeInTheDocument();
  expect(details.getByText("基本枠")).toBeInTheDocument();
  expect(details.getByText("集計期間 10080分")).toBeInTheDocument();
});
