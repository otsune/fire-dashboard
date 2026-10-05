import { afterEach, expect, it, vi } from "vitest";
import { createAudioController } from "../../apps/dashboard/src/audio/controller";
import { claimHour } from "../../apps/dashboard/src/audio/claims";
import { parseSettings } from "../../packages/contracts/src/index";

afterEach(() => vi.unstubAllGlobals());
it.each([true, false])(
  "requires an explicit retry after a contended enable, with Web Locks=%s",
  async (webLocks) => {
    let locked = false;
    vi.stubGlobal("navigator", {
      ...(webLocks && {
        locks: {
          request: async (
            _name: string,
            _options: unknown,
            work: (lock: object | null) => Promise<boolean>,
          ) => {
            if (locked) return work(null);
            locked = true;
            try {
              return await work({ name: "fire-dashboard-audio-v1" });
            } finally {
              locked = false;
            }
          },
        },
      }),
    });
    const hours = Object.fromEntries(
      Array.from({ length: 24 }, (_, hour) => [
        String(hour).padStart(2, "0"),
        { url: `/audio/${hour}.mp3`, license: "Synthetic fixture only" },
      ]),
    );
    const manifest = { hours: {}, hours24: hours, chime: null };
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let held = true,
      active = 0,
      maximum = 0;
    const played: string[] = [];
    const play = async (url: string) => {
      if (webLocks) expect(locked).toBe(true);
      played.push(url);
      maximum = Math.max(maximum, ++active);
      if (held) {
        entered();
        await completion;
        held = false;
      }
      active--;
    };
    const dependencies = { play, delay: async () => {} };
    const a = createAudioController(
      () => parseSettings({}),
      manifest,
      dependencies,
    );
    const b = createAudioController(
      () => parseSettings({}),
      manifest,
      dependencies,
    );
    try {
      const first = a.enable();
      await started;
      expect(await b.enable()).toBe(false);
      expect(b.state()).toEqual({
        enabled: false,
        ready: true,
        message: "別の画面で音声を再生中",
      });
      expect(played).toEqual(["/audio/0.mp3"]);
      expect(maximum).toBe(1);
      finish();
      expect(await first).toBe(true);
      expect(b.state().enabled).toBe(false);
      expect(await b.enable()).toBe(true);
      expect(a.state().enabled).toBe(true);
      expect(b.state().enabled).toBe(true);
      const key = `held-enable-hour-${webLocks}`;
      const decision = { key, hour: 10, reason: "boundary" };
      await Promise.all([a.announce(decision), b.announce(decision)]);
      expect(played).toEqual(["/audio/0.mp3", "/audio/0.mp3", "/audio/10.mp3"]);
      expect(await claimHour(key)).toBe(false);
      expect(maximum).toBe(1);
      expect(active).toBe(0);
    } finally {
      finish();
      await Promise.all([a.stop(), b.stop()]);
      a.dispose();
      b.dispose();
    }
  },
);
