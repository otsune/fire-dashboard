// @vitest-environment jsdom
import React from "react";
import { it, expect, vi, afterEach } from "vitest";
import {
  render,
  act,
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
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.replaceState({ dashboard: true }, "");
});
it("keeps actual preview playback running when only usage visibility changes", async () => {
  const hours = Object.fromEntries(
    Array.from({ length: 24 }, (_, hour) => [
      String(hour).padStart(2, "0"),
      { url: `/audio/hour-${hour}.mp3`, license: "Synthetic fixture only" },
    ]),
  );
  const assets: TestAudio[] = [];
  class TestAudio {
    playing = false;
    volume = 1;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public src: string) {
      assets.push(this);
    }
    play() {
      this.playing = true;
      return Promise.resolve();
    }
    pause() {
      this.playing = false;
    }
    removeAttribute() {
      this.src = "";
    }
    load() {}
  }
  vi.stubGlobal("Audio", TestAudio);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal("fetch", async (url: string) =>
    url.includes("license")
      ? new Response("DSEG license", {
          headers: { "Content-Type": "text/plain" },
        })
      : new Response(
          JSON.stringify(
            url.includes("manifest")
              ? { hours, hours24: hours, chime: null }
              : emptyDashboard(),
          ),
        ),
  );
  render(<App />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "試聴" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "試聴" }));
  await waitFor(() => expect(assets[0]?.playing).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  fireEvent.click(screen.getByRole("button", { name: "利用状況" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Claudeを表示する" }));
  expect(assets[0].playing).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "時計に戻る" }));
  await screen.findByTestId("clock-time");
  expect(assets[0].playing).toBe(true);
  expect(
    screen.getByRole("button", { name: "音声を有効にする" }),
  ).toBeEnabled();
  await act(async () => assets[0].onended?.());
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
