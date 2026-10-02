// @vitest-environment jsdom
import React from "react";
import { it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { emptyUsage, usageSchema } from "../../packages/contracts/src/index";
import { UsageCard } from "../../apps/dashboard/src/cards/UsageCard";
import { App } from "../../apps/dashboard/src/App";
const now = Date.parse("2026-10-02T00:00:00Z");
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
it.each([
  ["antigravity", "Antigravity"],
  ["opencode_go", "OpenCode Go"],
  ["hermes_nous", "Hermes / Nous"],
])("identifies %s independently", (provider, label) => {
  const value = usageSchema.parse({ ...emptyUsage("claude"), provider });
  render(<UsageCard value={value} timeZone="UTC" now={now} />);
  expect(
    screen.getByRole("heading", {
      name: new RegExp(label.replace("/", "\\/")),
    }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("progressbar")).toBeNull();
});
it.each([
  ["unconfigured", null, "収集処理が未設定です"],
  ["missing", "missing", "利用状況をまだ取得できていません"],
  ["unsupported", "unsupported", "この取得元は利用状況に未対応です"],
  ["error", "auth", "取得元の認証を確認してください"],
])(
  "explains empty %s state without claiming source-PC disconnection",
  (status, errorCode, message) => {
    const value = usageSchema.parse({
      ...emptyUsage("claude"),
      status,
      errorCode,
    });
    render(<UsageCard value={value} timeZone="UTC" now={now} />);
    expect(screen.getByText(message!)).toBeInTheDocument();
    expect(screen.queryByText("取得元PCに未接続")).toBeNull();
  },
);
it("shows separate USD balances without manufacturing quota bars", () => {
  const value = usageSchema.parse({
    ...emptyUsage("claude"),
    provider: "hermes_nous",
    status: "ok",
    balance: {
      currency: "USD",
      subscriptionRemaining: 25,
      purchasedRemaining: 12,
      totalRemaining: 37,
      monthlyAllowance: 20,
      renewsAt: null,
    },
  });
  render(<UsageCard value={value} timeZone="UTC" now={now} />);
  expect(screen.getByText("プラン残高").parentElement).toHaveTextContent(
    "$25.00",
  );
  expect(screen.getByText("追加購入残高").parentElement).toHaveTextContent(
    "$12.00",
  );
  expect(screen.getByText("合計残高").parentElement).toHaveTextContent(
    "$37.00",
  );
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText("収集処理が未設定です")).toBeNull();
});
it("shows five cards even when an older API snapshot contains only legacy providers", async () => {
  const { emptyDashboard } = await import("../../packages/contracts/src/index");
  const legacy = {
    ...emptyDashboard(),
    usage: [emptyUsage("claude"), emptyUsage("codex")],
  };
  vi.stubGlobal(
    "fetch",
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("manifest") ? { hours: {}, chime: null } : legacy,
        ),
      ),
  );
  render(<App />);
  await screen.findByText("集約サービス接続済み");
  for (const label of [
    "Claude",
    "Codex",
    "Antigravity",
    "OpenCode Go",
    "Hermes / Nous",
  ]) {
    const heading = screen.getByRole("heading", { name: new RegExp(label) });
    expect(
      within(heading.closest("section")!).queryByRole("progressbar"),
    ).toBeNull();
  }
});
it("marks an elapsed balance renewal as waiting without resetting USD values", async () => {
  const { deriveStatus } = await import("../../apps/dashboard/src/data/status");
  const value = usageSchema.parse({
    ...emptyUsage("claude"),
    provider: "hermes_nous",
    status: "ok",
    receivedAt: new Date(now).toISOString(),
    balance: {
      currency: "USD",
      subscriptionRemaining: 25,
      purchasedRemaining: 12,
      totalRemaining: 37,
      monthlyAllowance: 20,
      renewsAt: "2026-10-01T00:00:00.000Z",
    },
  });
  expect(deriveStatus(value, now).label).toBe("更新待ち");
  render(<UsageCard value={value} timeZone="UTC" now={now} />);
  expect(screen.getByText("合計残高").parentElement).toHaveTextContent(
    "$37.00",
  );
});
it.each([
  ["ok", "利用制限中"],
  ["error", "取得制限中"],
])(
  "makes %s rate limiting visible without replacing recorded quota",
  async (status, label) => {
    const { deriveStatus } =
      await import("../../apps/dashboard/src/data/status");
    const value = usageSchema.parse({
      ...emptyUsage("claude"),
      provider: "opencode_go",
      status,
      errorCode: "rate_limited",
      receivedAt: new Date(now).toISOString(),
      buckets: [
        {
          id: "go",
          label: "Go",
          windows: [
            {
              id: "weekly",
              label: "週間枠",
              usedPercent: 100,
              resetsAt: null,
              windowMinutes: null,
            },
          ],
        },
      ],
    });
    expect(deriveStatus(value, now).label).toBe(label);
    render(<UsageCard value={value} timeZone="UTC" now={now} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
  },
);
it("shows waiting after an old quota limit's reset while HTTP throttling remains explicit", async () => {
  const { deriveStatus } = await import("../../apps/dashboard/src/data/status");
  const value = usageSchema.parse({
    ...emptyUsage("opencode_go"),
    status: "ok",
    errorCode: "rate_limited",
    receivedAt: new Date(now).toISOString(),
    buckets: [
      {
        id: "go",
        label: "Go",
        windows: [
          {
            id: "weekly",
            label: "週間枠",
            usedPercent: 100,
            resetsAt: "2026-10-01T00:00:00.000Z",
            windowMinutes: null,
          },
        ],
      },
    ],
  });
  expect(deriveStatus(value, now).label).toBe("更新待ち");
  expect(deriveStatus({ ...value, status: "error" }, now).label).toBe(
    "取得制限中",
  );
});
