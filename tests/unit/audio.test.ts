import { it, expect, beforeEach } from "vitest";
import {
  claimHour,
  claimCount,
  acquireLease,
  releaseLease,
} from "../../apps/dashboard/src/audio/claims";
import { createAudioController } from "../../apps/dashboard/src/audio/controller";
import { parseSettings } from "../../packages/contracts/src/index";
const manifest = {
  hours: Object.fromEntries(
    Array.from({ length: 24 }, (_, i) => [
      String(i).padStart(2, "0"),
      { url: `/audio/${i}.mp3`, license: "test fixture only" },
    ]),
  ),
  chime: { url: "/audio/chime.mp3", license: "test fixture" },
};
let n = 0;
beforeEach(() => {
  n++;
});
it("atomically claims each hour once across simultaneous callers", async () => {
  expect(
    await Promise.all([claimHour(`same-${n}`), claimHour(`same-${n}`)]),
  ).toEqual([true, false]);
});
it("bounds the persistent history to 256 claims", async () => {
  for (let i = 0; i < 257; i++) await claimHour(`bound-${n}-${i}`);
  expect(await claimCount()).toBe(256);
});
it("lease excludes a different live owner and releases explicitly", async () => {
  expect(await acquireLease("a", "preview", 0)).toBe(true);
  expect(await acquireLease("b", "hourly", 1)).toBe(false);
  await releaseLease("a");
  expect(await acquireLease("b", "hourly", 2)).toBe(true);
  await releaseLease("b");
});
it("does not enable missing assets", async () => {
  const c = createAudioController(() => parseSettings({}), {
    hours: {},
    chime: null,
  });
  expect(await c.enable()).toBe(false);
  expect(c.state().enabled).toBe(false);
  c.dispose();
});
it("does not call a play refusal enabled and never retries a claimed failure", async () => {
  let fail = false,
    plays = 0;
  const c = createAudioController(() => parseSettings({}), manifest, {
    play: async () => {
      plays++;
      if (fail) throw Error("NotAllowedError");
    },
  });
  expect(await c.enable()).toBe(true);
  fail = true;
  const d = { key: `failed-${n}`, hour: 10, reason: "boundary" };
  await c.announce(d);
  await c.announce(d);
  expect(plays).toBe(2);
  expect(c.state().enabled).toBe(false);
  c.dispose();
});
it("initial play failure requires a fresh tap", async () => {
  const c = createAudioController(() => parseSettings({}), manifest, {
    play: async () => {
      throw Error("damaged");
    },
  });
  expect(await c.enable()).toBe(false);
  expect(c.state().message).toContain("再生できません");
  c.dispose();
});
it("serializes chime before voice and applies volume endpoints", async () => {
  const seen: { url: string; volume: number }[] = [];
  let volume = 0;
  const c = createAudioController(
    () => parseSettings({ audioMode: "both", volume }),
    manifest,
    {
      play: async (url, v) => {
        seen.push({ url, volume: v });
      },
      delay: async () => {},
    },
  );
  expect(await c.enable()).toBe(true);
  volume = 1;
  await c.preview(12);
  expect(seen.map((v) => v.url)).toEqual([
    "/audio/chime.mp3",
    "/audio/0.mp3",
    "/audio/chime.mp3",
    "/audio/12.mp3",
  ]);
  expect(seen.map((v) => v.volume)).toEqual([0, 0, 1, 1]);
  c.dispose();
});
it("fails closed if persistent claims cannot be written", async () => {
  const c = createAudioController(() => parseSettings({}), manifest, {
    play: async () => {},
    claim: async () => {
      throw Error("quota");
    },
  });
  await c.enable();
  await c.announce({ key: "quota", hour: 1, reason: "boundary" });
  expect(c.state().enabled).toBe(false);
  expect(c.state().message).toContain("保存");
  c.dispose();
});
it("repeated enable actions cannot overlap playback", async () => {
  let active = 0,
    max = 0;
  const c = createAudioController(() => parseSettings({}), manifest, {
    play: async (_url, _v, signal) => {
      active++;
      max = Math.max(max, active);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 20);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      active--;
    },
  });
  await Promise.all([c.enable(), c.enable()]);
  expect(max).toBe(1);
  c.dispose();
});
