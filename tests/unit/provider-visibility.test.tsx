// @vitest-environment jsdom
import React from "react";
import { afterEach, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  emptyDashboard,
  emptyUsage,
  defaultUsageVisibility,
  type Usage,
} from "../../packages/contracts/src/index";
import { AdditionalUsageCards } from "../../apps/dashboard/src/cards/AdditionalUsageCards";
afterEach(cleanup);
const now = Date.parse("2026-10-02T00:00:00Z");
it.each([{ usage: [] }, { usage: emptyDashboard().usage }])(
  "hides absent and untouched unconfigured extra providers",
  ({ usage }) => {
    const { container } = render(
      <AdditionalUsageCards
        usage={usage as Usage[]}
        timeZone="UTC"
        now={now}
      />,
    );
    expect(container.querySelectorAll(".usage-card")).toHaveLength(0);
  },
);
it.each([
  { sourceAlias: "pc" },
  { status: "missing" as const },
  { status: "error" as const, errorCode: "auth" as const },
  { capturedAt: "2026-10-02T00:00:00.000Z" },
  { receivedAt: "2026-10-02T00:00:00.000Z" },
  {
    buckets: [
      {
        id: "quota",
        label: "quota",
        windows: [
          {
            id: "quota",
            label: "quota",
            usedPercent: 0,
            resetsAt: null,
            windowMinutes: null,
          },
        ],
      },
    ],
  },
])(
  "keeps a configured, reporting or data-bearing extra card visible",
  (fields) => {
    render(
      <AdditionalUsageCards
        usage={[{ ...emptyUsage("antigravity"), ...fields }]}
        timeZone="UTC"
        now={now}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /Antigravity.*利用状況/ }),
    ).toBeInTheDocument();
    expect(document.querySelectorAll(".usage-card")).toHaveLength(1);
  },
);
it("retains explicit zero USD balance as data", () => {
  render(
    <AdditionalUsageCards
      usage={[
        {
          ...emptyUsage("hermes_nous"),
          balance: {
            currency: "USD",
            subscriptionRemaining: 0,
            purchasedRemaining: null,
            totalRemaining: 0,
            monthlyAllowance: null,
            renewsAt: null,
          },
        },
      ]}
      timeZone="UTC"
      now={now}
    />,
  );
  expect(
    screen.getByRole("heading", { name: /Hermes \/ Nous.*利用状況/ }),
  ).toBeInTheDocument();
  expect(document.querySelectorAll(".usage-card")).toHaveLength(1);
});
it("honors display-only visibility while restoring unchanged extra-provider values", () => {
  const usage = ["antigravity", "opencode_go", "hermes_nous"].map(
    (provider) => ({
      ...emptyUsage(provider as Usage["provider"]),
      status: "missing" as const,
      receivedAt: "2026-10-02T00:00:00.000Z",
    }),
  );
  const snapshot = structuredClone(usage);
  const { container, rerender } = render(
    <AdditionalUsageCards
      usage={usage}
      timeZone="UTC"
      now={now}
      visibility={{
        ...defaultUsageVisibility,
        antigravity: false,
        opencode_go: false,
        hermes_nous: false,
      }}
    />,
  );
  expect(container.querySelectorAll(".usage-card")).toHaveLength(0);
  rerender(
    <AdditionalUsageCards
      usage={usage}
      timeZone="UTC"
      now={now}
      visibility={defaultUsageVisibility}
    />,
  );
  expect(container.querySelectorAll(".usage-card")).toHaveLength(3);
  expect(usage).toEqual(snapshot);
  expect(container.querySelectorAll(".card-meta")[0]).toHaveTextContent(
    "最終受信",
  );
});
