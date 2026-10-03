// @vitest-environment jsdom
import React from "react";
import { it, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";
import { Clock } from "../../apps/dashboard/src/clock/Clock";
import { WeatherCard } from "../../apps/dashboard/src/cards/WeatherCard";
import { RssCard } from "../../apps/dashboard/src/cards/RssCard";
import {
  emptyDashboard,
  emptyCommon,
  parseSettings,
} from "../../packages/contracts/src/index";
afterEach(cleanup);
const now = Date.parse("2026-10-03T12:00:00Z");
it("keeps individually stackable hour and minute digits without a decorative caption", () => {
  const { container } = render(
    <Clock settings={parseSettings({})} now={() => now} />,
  );
  expect(container.querySelector(".clock-hours")).toHaveTextContent("21");
  expect(container.querySelector(".clock-minutes")).toHaveTextContent("00");
  expect(screen.queryByText("今日も、自分のペースで。")).toBeNull();
});
it("offers weather setup instructions from a compact empty card", () => {
  const { container } = render(
    <WeatherCard value={emptyDashboard().weather} timeZone="UTC" now={now} />,
  );
  const details = container.querySelector("details");
  expect(details).not.toBeNull();
  expect(details).not.toHaveAttribute("open");
  expect(details?.querySelector("summary")).toHaveTextContent("地域の設定方法");
  expect(screen.getByText("地域未設定")).toBeInTheDocument();
});
it("shows one headline while retaining every feed item in accessible details", () => {
  const feeds = [
    {
      ...emptyCommon("ok"),
      id: "f",
      label: "Feed",
      items: Array.from({ length: 6 }, (_, i) => ({
        id: String(i),
        title: `見出し${i}`,
        url: `https://example.com/${i}`,
        sourceLabel: "Feed",
        publishedAt: null,
      })),
    },
  ];
  const { container } = render(
    <RssCard feeds={feeds} autoRotate={false} timeZone="UTC" now={now} />,
  );
  expect(container.querySelectorAll(".headline-preview article")).toHaveLength(
    1,
  );
  const details = container.querySelector("details")!;
  expect(details.querySelectorAll("article")).toHaveLength(6);
  expect(details).not.toHaveAttribute("open");
  fireEvent.click(details.querySelector("summary")!);
  expect(screen.getByText("見出し5")).toBeInTheDocument();
});
it("stops headline rotation while a reader focuses the ticker", () => {
  vi.useFakeTimers();
  const feeds = [
    {
      ...emptyCommon("ok"),
      id: "f",
      label: "Feed",
      items: Array.from({ length: 3 }, (_, i) => ({
        id: String(i),
        title: `記事${i}`,
        url: `https://example.com/${i}`,
        sourceLabel: "Feed",
        publishedAt: null,
      })),
    },
  ];
  const { container } = render(
    <RssCard feeds={feeds} autoRotate={true} timeZone="UTC" now={now} />,
  );
  const preview = container.querySelector(".headline-preview")!;
  act(() => preview.querySelector("a")!.focus());
  act(() => vi.advanceTimersByTime(16000));
  expect(preview).toHaveTextContent("記事0");
  vi.useRealTimers();
});
