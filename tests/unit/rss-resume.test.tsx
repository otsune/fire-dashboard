// @vitest-environment jsdom
import React from "react";
import { it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  cleanup,
} from "@testing-library/react";
import { RssCard } from "../../apps/dashboard/src/cards/RssCard";
import { emptyCommon } from "../../packages/contracts/src/index";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function setup() {
  vi.useFakeTimers();
  const feeds = [
    {
      ...emptyCommon("ok"),
      id: "f",
      label: "Feed",
      items: [0, 1, 2].map((i) => ({
        id: String(i),
        title: `Headline ${i}`,
        url: `https://example.com/${i}`,
        sourceLabel: "Feed",
        publishedAt: null,
      })),
    },
  ];
  const { container } = render(
    <>
      <RssCard
        feeds={feeds}
        autoRotate={true}
        timeZone="UTC"
        now={Date.now()}
      />
      <button>Outside</button>
    </>,
  );
  return {
    preview: container.querySelector(".headline-preview")!,
    container,
    toggle: screen.getByRole("button", { name: "切替を停止" }),
  };
}
it("resumes rotation while the toggle button keeps focus", () => {
  const { preview, toggle } = setup();
  act(() => vi.advanceTimersByTime(15000));
  expect(preview).toHaveTextContent("Headline 1");
  act(() => toggle.focus());
  fireEvent.click(toggle);
  expect(toggle).toHaveTextContent("切替を再開");
  act(() => vi.advanceTimersByTime(15000));
  expect(preview).toHaveTextContent("Headline 1");
  fireEvent.click(toggle);
  expect(toggle).toHaveTextContent("切替を停止");
  expect(toggle).toHaveFocus();
  act(() => vi.advanceTimersByTime(15000));
  expect(preview).toHaveTextContent("Headline 2");
  expect(toggle).toHaveFocus();
});
it("pauses while reading a headline and resumes when focus moves to the control", () => {
  const { preview, toggle } = setup();
  act(() => preview.querySelector("a")!.focus());
  act(() => vi.advanceTimersByTime(30000));
  expect(preview).toHaveTextContent("Headline 0");
  act(() => toggle.focus());
  act(() => vi.advanceTimersByTime(15000));
  expect(preview).toHaveTextContent("Headline 1");
});
it("keeps expanded feed details paused even with focus on the resume control", () => {
  const { preview, toggle, container } = setup();
  const details = container.querySelector("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  act(() => toggle.focus());
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  act(() => vi.advanceTimersByTime(30000));
  expect(preview).toHaveTextContent("Headline 0");
  details.open = false;
  fireEvent(details, new Event("toggle"));
  act(() => vi.advanceTimersByTime(15000));
  expect(preview).toHaveTextContent("Headline 1");
});
it("resumes when focus leaves the headline for an outside control", () => {
  const { preview } = setup();
  act(() => preview.querySelector("a")!.focus());
  act(() => vi.advanceTimersByTime(15000));
  expect(preview).toHaveTextContent("Headline 0");
  act(() => screen.getByRole("button", { name: "Outside" }).focus());
  act(() => vi.advanceTimersByTime(15000));
  expect(preview).toHaveTextContent("Headline 1");
});
it("resumes after the detail close button restores focus to the summary", () => {
  const { preview, container } = setup();
  const details = container.querySelector("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  const close = screen.getByRole("button", { name: "詳細を閉じる" });
  act(() => close.focus());
  act(() => vi.advanceTimersByTime(15000));
  expect(preview).toHaveTextContent("Headline 0");
  fireEvent.click(close);
  expect(details.open).toBe(false);
  expect(details.querySelector("summary")).toHaveFocus();
  fireEvent(details, new Event("toggle"));
  act(() => vi.advanceTimersByTime(15000));
  expect(preview).toHaveTextContent("Headline 1");
});
