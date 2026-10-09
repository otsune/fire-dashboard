// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { App } from "../../apps/dashboard/src/App";
import {
  emptyDashboard,
  parseSettings,
} from "../../packages/contracts/src/index";
import { claimCount } from "../../apps/dashboard/src/audio/claims";

const hours = Object.fromEntries(
  Array.from({ length: 24 }, (_, hour) => [
    String(hour).padStart(2, "0"),
    { url: `/audio/hour-${hour}.mp3`, license: "Synthetic fixture only" },
  ]),
);
const assets: HeldAudio[] = [];
class HeldAudio {
  playing = false;
  interrupted = false;
  volume = 1;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly requested: string;
  constructor(public src: string) {
    this.requested = src;
    assets.push(this);
  }
  play() {
    this.playing = true;
    return Promise.resolve();
  }
  pause() {
    this.interrupted ||= this.playing;
    this.playing = false;
  }
  finish() {
    this.playing = false;
    this.onended?.();
  }
  removeAttribute() {
    this.src = "";
  }
  load() {}
}

let wall: number, mono: number, hidden: boolean;
let scheduler: (() => void) | null;
beforeEach(() => {
  assets.length = 0;
  scheduler = null;
  hidden = false;
  wall = Date.parse("2026-10-02T10:59:55Z");
  mono = 1000;
  localStorage.setItem(
    "fire-dashboard-settings-v1",
    JSON.stringify(parseSettings({ timeZone: "UTC" })),
  );
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  vi.spyOn(performance, "now").mockImplementation(() => mono);
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  // Capture the real App scheduler only. Media completion, IndexedDB, React,
  // and the controller remain real; other timers retain their usual behavior.
  const setInterval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(
    (callback, interval, ...args) => {
      if (interval === 250) {
        scheduler = () => callback(...args);
        return setInterval(() => {}, 60000);
      }
      return setInterval(callback, interval, ...args);
    },
  );
  vi.stubGlobal("Audio", HeldAudio);
  vi.stubGlobal("fetch", async (url: string) =>
    url.includes("license")
      ? new Response("DSEG license", {
          headers: { "Content-Type": "text/plain" },
        })
      : new Response(
          JSON.stringify(
            url.includes("manifest")
              ? {
                  hours,
                  hours24: hours,
                  chime: {
                    url: "/audio/chime.wav",
                    license: "Synthetic fixture only",
                  },
                }
              : emptyDashboard(),
          ),
        ),
  );
});
afterEach(async () => {
  cleanup();
  // Let actual lease-release transactions settle before the next App mounts.
  await claimCount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  window.history.replaceState({ dashboard: true }, "");
});
async function mount() {
  render(<App />);
  await waitFor(() => {
    expect(scheduler).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "音声を有効にする" }),
    ).toBeEnabled();
  });
}
async function tick(wallAdvance = 250, monoAdvance = wallAdvance) {
  await act(async () => {
    wall += wallAdvance;
    mono += monoAdvance;
    scheduler!();
  });
}
async function edit(change: () => void) {
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  change();
  fireEvent.click(screen.getByRole("button", { name: "時計に戻る" }));
  await screen.findByTestId("clock-time");
}
async function enable() {
  const index = assets.length;
  fireEvent.click(screen.getByRole("button", { name: "音声を有効にする" }));
  await waitFor(() => expect(assets[index]?.playing).toBe(true));
  return assets[index];
}
async function finish(asset: HeldAudio) {
  await act(async () => asset.finish());
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "音声を無効にする" }),
    ).toBeEnabled(),
  );
}
const changes = [
  [
    "audio mode",
    () =>
      fireEvent.change(screen.getByLabelText("時報の種類"), {
        target: { value: "chime" },
      }),
  ],
  [
    "volume",
    () =>
      fireEvent.change(screen.getByLabelText("アプリ内音量"), {
        target: { value: "75" },
      }),
  ],
  [
    "quiet enabled outside its window",
    () => fireEvent.click(screen.getByLabelText("静音時間を使う")),
  ],
  [
    "quiet start",
    () =>
      fireEvent.change(screen.getByLabelText("静音開始"), {
        target: { value: "21:00" },
      }),
  ],
  [
    "quiet end",
    () =>
      fireEvent.change(screen.getByLabelText("静音終了"), {
        target: { value: "08:00" },
      }),
  ],
  ["hour format", () => fireEvent.click(screen.getByLabelText("12時間表記"))],
  [
    "time zone",
    () => {
      const input = screen.getByLabelText("タイムゾーン");
      fireEvent.change(input, { target: { value: "Asia/Tokyo" } });
      fireEvent.blur(input);
    },
  ],
] as const;

it.each(changes)(
  "preserves a fresh enable before the next scheduler tick after changing %s",
  async (_name, change) => {
    await mount();
    await tick();
    await edit(change);
    expect(assets).toHaveLength(0);
    const preview = await enable();
    await tick();
    expect(preview.playing).toBe(true);
    expect(preview.interrupted).toBe(false);
    await finish(preview);
    expect(screen.getByText("音声有効", { exact: true })).toBeInTheDocument();
  },
);

it("also enables when the settings baseline tick precedes the fresh tap", async () => {
  await mount();
  await tick();
  await edit(changes[0][1]);
  await tick();
  const preview = await enable();
  await tick();
  expect(preview.playing).toBe(true);
  await finish(preview);
});
it("still cancels old playback immediately on an audio settings change", async () => {
  await mount();
  await tick();
  const old = await enable();
  await edit(changes[0][1]);
  expect(old.playing).toBe(false);
  expect(old.interrupted).toBe(true);
  expect(assets).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "音声を有効にする" }),
  ).toBeEnabled();
  const fresh = await enable();
  await tick();
  expect(fresh.playing).toBe(true);
  await finish(fresh);
});
it.each(["hidden", "quiet", "clock correction"])(
  "preserves %s cancellation after resetting a settings baseline",
  async (scenario) => {
    await mount();
    await tick();
    await edit(changes[0][1]);
    if (scenario === "quiet") {
      await edit(() => {
        fireEvent.click(screen.getByLabelText("静音時間を使う"));
        fireEvent.change(screen.getByLabelText("静音開始"), {
          target: { value: "10:00" },
        });
        fireEvent.change(screen.getByLabelText("静音終了"), {
          target: { value: "12:00" },
        });
      });
    }
    if (scenario === "clock correction") await tick();
    const preview = await enable();
    if (scenario === "hidden") {
      await act(async () => {
        hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
      });
    } else await tick(scenario === "clock correction" ? 10000 : 250, 250);
    expect(preview.playing).toBe(false);
    expect(preview.interrupted).toBe(true);
    expect(
      screen.getByRole("button", { name: "音声を有効にする" }),
    ).toBeEnabled();
  },
);
it.each([
  { name: "forward clock correction", wallAdvance: 10000, monoAdvance: 250 },
  { name: "backward clock correction", wallAdvance: -10000, monoAdvance: 250 },
  { name: "suspended scheduler", wallAdvance: 16000, monoAdvance: 16000 },
])(
  "cancels a fresh preview on $name at the first tick after settings change",
  async ({ wallAdvance, monoAdvance }) => {
    await mount();
    await tick();
    await edit(changes[0][1]);
    const preview = await enable();
    await tick(wallAdvance, monoAdvance);
    expect(preview.playing).toBe(false);
    expect(preview.interrupted).toBe(true);
    expect(
      screen.getByRole("button", { name: "音声を有効にする" }),
    ).toBeEnabled();
  },
);
it("does not announce a crossed hour when settings reset the baseline", async () => {
  await mount();
  const preview = await enable();
  await finish(preview);
  await tick();
  const before = await claimCount();
  await edit(changes[1][1]);
  await tick(5000);
  await tick();
  expect(assets.map((asset) => asset.requested)).toEqual(["/audio/hour-0.mp3"]);
  expect(await claimCount()).toBe(before);
});
it("still announces a normally observed hour after a settings baseline reset", async () => {
  await mount();
  await tick();
  await edit(changes[1][1]);
  const preview = await enable();
  await finish(preview);
  await tick();
  const before = await claimCount();
  await tick(5000);
  await waitFor(() => expect(assets[1]?.playing).toBe(true));
  expect(assets[1].requested).toBe("/audio/hour-11.mp3");
  expect(await claimCount()).toBe(before + 1);
  await act(async () => assets[1].finish());
});
