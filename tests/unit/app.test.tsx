// @vitest-environment jsdom
import React from "react";
import { it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { App } from "../../apps/dashboard/src/App";
import { emptyDashboard } from "../../packages/contracts/src/index";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
it("integrates unconfigured cards, settings round-trip and disabled absent audio", async () => {
  vi.stubGlobal(
    "fetch",
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("manifest")
            ? { hours: {}, chime: null }
            : emptyDashboard(),
        ),
        { status: 200 },
      ),
  );
  render(<App />);
  expect(screen.getByText("地域未設定")).toBeInTheDocument();
  expect(screen.getByText("フィード未登録")).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByText("集約サービス接続済み")).toBeInTheDocument(),
  );
  expect(
    screen.getByRole("button", { name: "音声を有効にする" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "12時間表記" }));
  fireEvent.click(screen.getByRole("button", { name: "時計に戻る" }));
  expect(screen.getByTestId("clock-time")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  expect(screen.getByRole("checkbox", { name: "12時間表記" })).toBeChecked();
});
it("closes an open detail with Escape and restores its summary focus", async () => {
  vi.stubGlobal(
    "fetch",
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("manifest")
            ? { hours: {}, chime: null }
            : emptyDashboard(),
        ),
      ),
  );
  const { container } = render(<App />);
  await screen.findByText("集約サービス接続済み");
  const details = container.querySelector<HTMLDetailsElement>(
    ".weather-card details",
  )!;
  details.open = true;
  const close = details.querySelector<HTMLButtonElement>("button")!;
  close.focus();
  fireEvent.keyDown(close, { key: "Escape" });
  expect(details.open).toBe(false);
  expect(details.querySelector("summary")).toHaveFocus();
});
