import { expect, it, vi, afterEach } from "vitest";
import {
  modeReady,
  parseManifest,
  loadManifest,
} from "../../apps/dashboard/src/audio/manifest";
import { createAudioController } from "../../apps/dashboard/src/audio/controller";
import { parseSettings } from "../../packages/contracts/src/index";

const set = (format: string, ext: string) =>
  Object.fromEntries(
    Array.from({ length: 24 }, (_, h) => {
      const key = String(h).padStart(2, "0");
      return [
        key,
        {
          url: `/audio/private/${format}/hour-${key}.${ext}`,
          license: "Synthetic fixture only",
        },
      ];
    }),
  );
const manifest = {
  hours: set("12h", "mp3"),
  hours24: set("24h", "wav"),
  chime: {
    url: "/audio/chime_Eb5_C5_Eb5_Ab5.wav",
    license: "Original synthesized chime; Unlicense",
  },
};
it("retains both independently keyed voice sets", () => {
  expect(parseManifest(manifest)).toEqual(manifest);
  expect(modeReady(manifest, "both", true)).toBe(true);
  expect(modeReady(manifest, "both", false)).toBe(true);
});
it("accepts a legacy manifest as 12-hour only without falling back in 24-hour mode", () => {
  const legacy = { hours: manifest.hours, chime: manifest.chime };
  expect(parseManifest(legacy)).toEqual(legacy);
  expect(modeReady(legacy, "voice", true)).toBe(true);
  expect(modeReady(legacy, "voice", false)).toBe(false);
  expect(modeReady(legacy, "both", false)).toBe(false);
  expect(modeReady(legacy, "chime", false)).toBe(true);
});
it("does not borrow a missing hour from the other format", () => {
  const partial = { ...manifest, hours24: { ...manifest.hours24 } };
  delete partial.hours24["12"];
  expect(modeReady(partial, "voice", false)).toBe(false);
  expect(modeReady(partial, "voice", true)).toBe(true);
});
it("rejects unsafe 24-hour URLs at the manifest boundary", () => {
  expect(
    modeReady(
      {
        ...manifest,
        hours24: {
          ...manifest.hours24,
          "00": { url: "https://example.com/voice.wav", license: "fixture" },
        },
      },
      "voice",
      false,
    ),
  ).toBe(false);
});
it.each([true, false])(
  "selects the correct midnight, noon, and 23:00 clips when hour12=%s",
  async (hour12) => {
    const seen: (string | number)[] = [];
    const c = createAudioController(
      () => parseSettings({ hour12, audioMode: "both" }),
      manifest,
      {
        play: async (url) => {
          seen.push(url);
        },
        delay: async (ms) => {
          seen.push(ms);
        },
      },
    );
    try {
      expect(await c.enable()).toBe(true);
      await c.preview(12);
      await c.preview(23);
      const clips = hour12 ? manifest.hours : manifest.hours24;
      expect(seen).toEqual([
        manifest.chime.url,
        300,
        clips["00"].url,
        manifest.chime.url,
        300,
        clips["12"].url,
        manifest.chime.url,
        300,
        clips["23"].url,
      ]);
    } finally {
      c.dispose();
    }
  },
);
it("switches future playback to the selected format without playing on the settings change", async () => {
  let settings = parseSettings({ hour12: true });
  const seen: string[] = [];
  const c = createAudioController(() => settings, manifest, {
    play: async (url) => {
      seen.push(url);
    },
  });
  try {
    await c.enable();
    settings = { ...settings, hour12: false };
    await c.settingsChanged();
    expect(seen).toEqual([manifest.hours["00"].url]);
    expect(c.state().enabled).toBe(true);
    await c.preview(12);
    expect(seen.at(-1)).toBe(manifest.hours24["12"].url);
  } finally {
    c.dispose();
  }
});
it("clearly disables an unavailable format and requires a fresh tap after returning", async () => {
  let settings = parseSettings({ hour12: true });
  const c = createAudioController(
    () => settings,
    { hours: manifest.hours, chime: manifest.chime },
    { play: async () => {} },
  );
  try {
    await c.enable();
    settings = { ...settings, hour12: false };
    await c.settingsChanged();
    expect(c.state()).toMatchObject({
      enabled: false,
      ready: false,
      message: "24時間表記の音声が未設定",
    });
    expect(await c.enable()).toBe(false);
    settings = { ...settings, hour12: true };
    await c.settingsChanged();
    expect(c.state()).toMatchObject({ enabled: false, ready: true });
    expect(await c.enable()).toBe(true);
  } finally {
    c.dispose();
  }
});
it("reports missing 12-hour clips even if the 24-hour set is complete", () => {
  const c = createAudioController(() => parseSettings({ hour12: true }), {
    ...manifest,
    hours: {},
  });
  expect(c.state()).toMatchObject({
    enabled: false,
    ready: false,
    message: "12時間表記の音声が未設定",
  });
  c.dispose();
});
it.each(["chime", "voice"])(
  "stops an in-flight %s on format change instead of continuing old playback",
  async (phase) => {
    let settings = parseSettings({ hour12: true, audioMode: "both" });
    let block = false;
    let aborted = false;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const seen: string[] = [];
    const c = createAudioController(() => settings, manifest, {
      play: async (url, _volume, signal) => {
        seen.push(url);
        if (
          block &&
          (phase === "chime"
            ? url === manifest.chime.url
            : url === manifest.hours["23"].url)
        ) {
          entered();
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            );
          });
        }
      },
      delay: async () => {},
    });
    try {
      await c.enable();
      block = true;
      const pending = c.preview(23);
      await started;
      settings = { ...settings, hour12: false };
      await c.settingsChanged();
      await pending;
      expect(seen).toEqual([
        manifest.chime.url,
        manifest.hours["00"].url,
        manifest.chime.url,
        ...(phase === "voice" ? [manifest.hours["23"].url] : []),
      ]);
      expect(aborted).toBe(true);
      expect(c.state().enabled).toBe(true);
    } finally {
      await c.stop();
      c.dispose();
    }
  },
);

afterEach(() => vi.unstubAllGlobals());
it("loads both complete sets with long license metadata within the bounded 128 KiB manifest", async () => {
  const withLicenses = (hours: typeof manifest.hours) =>
    Object.fromEntries(
      Object.entries(hours).map(([key, asset]) => [
        key,
        { ...asset, license: "L".repeat(1800) },
      ]),
    );
  const value = {
    ...manifest,
    hours: withLicenses(manifest.hours),
    hours24: withLicenses(manifest.hours24),
  };
  const text = JSON.stringify(value);
  expect(text.length).toBeGreaterThan(65536);
  expect(text.length).toBeLessThan(131072);
  vi.stubGlobal("fetch", async () => new Response(text));
  const loaded = await loadManifest();
  expect(modeReady(loaded, "both", true)).toBe(true);
  expect(modeReady(loaded, "both", false)).toBe(true);
});
