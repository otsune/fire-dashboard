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
  vi.restoreAllMocks();
});
const feeds = (prefix: string) => [
  {
    ...emptyCommon("ok"),
    id: "f",
    label: "Feed",
    items: [0, 1, 2].map((i) => ({
      id: `${prefix}${i}`,
      title: `${prefix}${i}`,
      url: `https://example.com/${prefix}${i}`,
      sourceLabel: "Feed",
      publishedAt: null,
    })),
  },
];
function setup() {
  vi.useFakeTimers();
  const props = { autoRotate: true, timeZone: "UTC", now: Date.now() };
  const ui = (prefix: string) => (
    <>
      <RssCard {...props} feeds={feeds(prefix)} />
      <button>Outside</button>
    </>
  );
  const result = render(ui("old"));
  const preview = result.container.querySelector(".headline-preview")!;
  const link = preview.querySelector("a")!;
  act(() => link.focus());
  return {
    ...result,
    preview,
    link,
    refresh: () => result.rerender(ui("new")),
  };
}
const tick = () => act(() => vi.advanceTimersByTime(15000));
function visibility(hidden: boolean) {
  vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
  fireEvent(document, new Event("visibilitychange"));
}
function activate(link: HTMLAnchorElement) {
  fireEvent.click(link, { detail: 1 });
}
it("resumes when a data refresh removes the focused headline without blur", () => {
  const { link, preview, refresh } = setup();
  refresh();
  expect(link.isConnected).toBe(false);
  expect(document.activeElement).toBe(document.body);
  tick();
  expect(preview).toHaveTextContent("new1");
});
it("keeps ordinary keyboard reading paused across unrelated visibility changes", () => {
  const { link, preview } = setup();
  visibility(true);
  visibility(false);
  fireEvent(window, new Event("focus"));
  tick();
  expect(preview).toHaveTextContent("old0");
  expect(link).toHaveFocus();
});
it("resumes after explicit article activation and a hidden/visible round trip without blurring", () => {
  const { link, preview } = setup();
  activate(link);
  visibility(true);
  tick();
  expect(preview).toHaveTextContent("old0");
  visibility(false);
  expect(link).toHaveFocus();
  tick();
  expect(preview).toHaveTextContent("old1");
});
it("resumes after explicit article activation and window blur/focus in either return ordering", () => {
  const { link, preview } = setup();
  activate(link);
  fireEvent(window, new Event("blur"));
  visibility(true);
  fireEvent(window, new Event("focus"));
  visibility(false);
  fireEvent.focus(link);
  tick();
  expect(preview).toHaveTextContent("old1");
});
it("does not resume merely because a link was activated without a departure", () => {
  const { link, preview } = setup();
  activate(link);
  fireEvent(window, new Event("focus"));
  tick();
  expect(preview).toHaveTextContent("old0");
});
it("keeps a manual pause through the article round trip", () => {
  const { link, preview } = setup();
  fireEvent.click(screen.getByRole("button", { name: "切替を停止" }));
  activate(link);
  visibility(true);
  visibility(false);
  tick();
  expect(preview).toHaveTextContent("old0");
});
it("keeps expanded details paused through an article round trip", () => {
  const { link, preview, container } = setup();
  const details = container.querySelector("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  activate(link);
  visibility(true);
  visibility(false);
  tick();
  expect(preview).toHaveTextContent("old0");
});
it("resumes reading pause on deliberate keyboard interaction after returning", () => {
  const { link, preview } = setup();
  activate(link);
  visibility(true);
  visibility(false);
  fireEvent.keyDown(link, { key: "ArrowDown" });
  tick();
  expect(preview).toHaveTextContent("old0");
});
it("does not carry an old article activation through a later keyboard tab switch", () => {
  const { link, preview } = setup();
  activate(link);
  fireEvent.keyDown(link, { key: "Tab", altKey: true });
  visibility(true);
  visibility(false);
  tick();
  expect(preview).toHaveTextContent("old0");
});
it("reinstates reading pause after focus moves outside and back after return", () => {
  const { link, preview } = setup();
  activate(link);
  visibility(true);
  visibility(false);
  act(() => screen.getByRole("button", { name: "Outside" }).focus());
  act(() => link.focus());
  tick();
  expect(preview).toHaveTextContent("old0");
});
it("handles visibility return before window focus and later link-focus restoration", () => {
  const { link, preview } = setup();
  activate(link);
  fireEvent(window, new Event("blur"));
  visibility(true);
  visibility(false);
  fireEvent(window, new Event("focus"));
  fireEvent.focus(link);
  tick();
  expect(preview).toHaveTextContent("old1");
});
it("does not reuse an article-return exemption for a later unrelated departure", () => {
  const { link, preview } = setup();
  activate(link);
  visibility(true);
  visibility(false);
  visibility(true);
  visibility(false);
  tick();
  expect(preview).toHaveTextContent("old0");
});
it.each([
  { ctrlKey: true },
  { metaKey: true },
  { altKey: true },
  { shiftKey: true },
  { button: 1 },
])(
  "does not infer an article trip from modified activation %j",
  (modifiers) => {
    const { link, preview } = setup();
    fireEvent.click(link, { detail: 1, ...modifiers });
    visibility(true);
    visibility(false);
    tick();
    expect(preview).toHaveTextContent("old0");
  },
);
it("does not infer a trip from a canceled link activation", () => {
  const { link, preview } = setup();
  const click = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    detail: 1,
  });
  click.preventDefault();
  fireEvent(link, click);
  visibility(true);
  visibility(false);
  tick();
  expect(preview).toHaveTextContent("old0");
});
it("cancels an uncompleted article activation on a later pointer interaction", () => {
  const { link, preview } = setup();
  activate(link);
  fireEvent.pointerDown(link);
  visibility(true);
  visibility(false);
  tick();
  expect(preview).toHaveTextContent("old0");
});
it("returns to reading pause after a fresh pointer interaction on the retained link", () => {
  const { link, preview } = setup();
  activate(link);
  visibility(true);
  visibility(false);
  fireEvent.pointerDown(link);
  tick();
  expect(preview).toHaveTextContent("old0");
});
it("permits an explicit keyboard article round trip while retaining focus until rotation", () => {
  const { link, preview } = setup();
  fireEvent.keyDown(link, { key: "Enter" });
  fireEvent.click(link, { detail: 0 });
  visibility(true);
  visibility(false);
  expect(link).toHaveFocus();
  tick();
  expect(preview).toHaveTextContent("old1");
});
