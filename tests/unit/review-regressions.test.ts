import { it, expect, vi, afterEach } from "vitest";
import {
  loadSettings,
  saveSettings,
} from "../../apps/dashboard/src/settings/store";
import { parseSettings } from "../../packages/contracts/src/index";
import {
  modeReady,
  loadManifest,
  type AudioManifest,
} from "../../apps/dashboard/src/audio/manifest";
import { createAudioController } from "../../apps/dashboard/src/audio/controller";
import {
  acquireLease,
  releaseLease,
} from "../../apps/dashboard/src/audio/claims";
const manifest: AudioManifest = {
  hours: Object.fromEntries(
    Array.from({ length: 24 }, (_, h) => [
      String(h).padStart(2, "0"),
      { url: `/audio/${h}.mp3`, license: "test fixture" },
    ]),
  ),
  chime: null,
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("keeps the clock settings usable when the localStorage property getter throws", () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("denied", "SecurityError");
    },
  });
  try {
    expect(loadSettings().value.timeZone).toBe("Asia/Tokyo");
    expect(loadSettings().warning).toBeTruthy();
    expect(saveSettings(parseSettings({}))).toBe(false);
  } finally {
    if (old) Object.defineProperty(globalThis, "localStorage", old);
    else delete (globalThis as { localStorage?: Storage }).localStorage;
  }
});
it("malformed nested audio fields cannot throw during render readiness", () => {
  const bad = {
    ...manifest,
    hours: { ...manifest.hours, "00": { url: "/audio/0.mp3" } },
  } as unknown as AudioManifest;
  expect(() => modeReady(bad, "voice")).not.toThrow();
  expect(modeReady(bad, "voice")).toBe(false);
  expect(() =>
    modeReady(
      { hours: null, chime: null } as unknown as AudioManifest,
      "voice",
    ),
  ).not.toThrow();
});
it("rejects a malformed full manifest at the fetch boundary", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          ...manifest,
          hours: { ...manifest.hours, "00": { url: "/audio/0.mp3" } },
        }),
        { status: 200 },
      ),
  );
  expect(await loadManifest()).toEqual({ hours: {}, chime: null });
});
it.each(["disable", "stop", "hidden", "settings", "expired"])(
  "cancels a deferred hourly claim after %s",
  async (scenario) => {
    let resolve!: (value: boolean) => void;
    let wall = 0,
      mono = 0,
      visible = true;
    let settings = parseSettings({ timeZone: "UTC" });
    const played: string[] = [];
    const c = createAudioController(() => settings, manifest, {
      play: async (url) => {
        played.push(url);
      },
      claim: () =>
        new Promise((r) => {
          resolve = r;
        }),
      delay: async () => {},
      now: () => wall,
      monoNow: () => mono,
      visible: () => visible,
    });
    try {
      await c.enable();
      const pending = c.announce({
        key: "deferred-" + scenario,
        hour: 10,
        reason: "boundary",
        expiresAt: 10000,
      });
      if (scenario === "disable") c.disable();
      if (scenario === "stop") await c.stop();
      if (scenario === "hidden") visible = false;
      if (scenario === "settings")
        settings = { ...settings, timeZone: "Asia/Tokyo" };
      if (scenario === "expired") {
        wall = 10001;
        mono = 10001;
      }
      resolve(true);
      await pending;
      expect(played).toEqual(["/audio/0.mp3"]);
      if (scenario === "disable") expect(c.state().message).toBe("音声無効");
    } finally {
      await c.stop();
      c.dispose();
    }
  },
);
it("rechecks the expiry after waiting for playback arbitration", async () => {
  let wall = 0,
    mono = 0;
  const played: string[] = [];
  const c = createAudioController(
    () => parseSettings({ timeZone: "UTC" }),
    manifest,
    {
      play: async (url) => {
        played.push(url);
      },
      claim: async () => true,
      now: () => wall,
      monoNow: () => mono,
      delay: async () => {
        wall = 10001;
        mono = 10001;
      },
    },
  );
  try {
    await c.enable();
    await c.announce({
      key: "late-after-claim",
      hour: 10,
      reason: "boundary",
      expiresAt: 10000,
    });
    expect(played).toEqual(["/audio/0.mp3"]);
  } finally {
    await c.stop();
    c.dispose();
  }
});
it("a wall-clock jump cannot steal a live owner lease", async () => {
  let wall = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => wall);
  let started!: () => void;
  const playing = new Promise<void>((r) => {
    started = r;
  });
  let active = 0,
    max = 0;
  const a = createAudioController(() => parseSettings({}), manifest, {
    play: async (url, _v, signal) => {
      if (url === "/audio/0.mp3") return;
      active++;
      max = Math.max(max, active);
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            active--;
            resolve();
          },
          { once: true },
        ),
      );
    },
  });
  const b = createAudioController(() => parseSettings({}), manifest, {
    play: async () => {
      active++;
      max = Math.max(max, active);
      active--;
    },
  });
  try {
    await a.enable();
    const pending = a.preview(10);
    await playing;
    wall += 60000;
    expect(await b.enable()).toBe(false);
    expect(max).toBe(1);
    await a.stop();
    await pending;
    expect(await b.enable()).toBe(true);
  } finally {
    await a.stop();
    await b.stop();
    a.dispose();
    b.dispose();
  }
});
it("expired unknown-owner records fail closed when no exclusive browser lock exists", async () => {
  await acquireLease("orphan-a", "preview", 0);
  try {
    expect(await acquireLease("orphan-b", "hourly", 60000)).toBe(false);
  } finally {
    await releaseLease("orphan-a");
    await releaseLease("orphan-b");
  }
});
it("recovers an orphan only while holding an exclusive browser lock", async () => {
  await acquireLease("orphan-web", "preview", Date.now());
  let locked = false;
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: object | null) => Promise<boolean>,
      ) => {
        if (locked) return callback(null);
        locked = true;
        try {
          return await callback({ name: "fire-dashboard-audio-v1" });
        } finally {
          locked = false;
        }
      },
    },
  });
  const c = createAudioController(() => parseSettings({}), manifest, {
    play: async () => {
      expect(locked).toBe(true);
    },
  });
  try {
    expect(await c.enable()).toBe(true);
  } finally {
    await c.stop();
    c.dispose();
    await releaseLease("orphan-web");
  }
});
it("identifies a live browser lock as busy instead of missing assets", async () => {
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _name: string,
        _options: unknown,
        callback: (lock: null) => Promise<boolean>,
      ) => callback(null),
    },
  });
  const c = createAudioController(() => parseSettings({}), manifest, {
    play: async () => {
      throw Error("must not play");
    },
  });
  try {
    expect(await c.enable()).toBe(false);
    expect(c.state().message).toContain("別の画面");
  } finally {
    await c.stop();
    c.dispose();
  }
});
