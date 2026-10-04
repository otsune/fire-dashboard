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
it("links voice availability to the clock's existing 12-hour checkbox", async () => {
  const hours = Object.fromEntries(
    Array.from({ length: 24 }, (_, h) => [
      String(h).padStart(2, "0"),
      { url: `/audio/hour-${h}.mp3`, license: "Synthetic fixture only" },
    ]),
  );
  vi.stubGlobal(
    "fetch",
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("manifest") ? { hours, chime: null } : emptyDashboard(),
        ),
      ),
  );
  render(<App />);
  await waitFor(() =>
    expect(screen.getByText("24時間表記の音声が未設定")).toBeInTheDocument(),
  );
  expect(
    screen.getByRole("button", { name: "音声を有効にする" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "12時間表記" }));
  fireEvent.click(screen.getByRole("button", { name: "時計に戻る" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "音声を有効にする" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "12時間表記" }));
  fireEvent.click(screen.getByRole("button", { name: "時計に戻る" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "音声を有効にする" }),
    ).toBeDisabled(),
  );
  expect(screen.getByText("24時間表記の音声が未設定")).toBeInTheDocument();
});
