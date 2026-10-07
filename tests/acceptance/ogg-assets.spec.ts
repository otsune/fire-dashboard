import { test, expect } from "@playwright/test";
// Decode only in headless Chromium; no speaker playback or Fire audio enabling.
test("both bundled hourly Ogg sets decode and remain available offline", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const manifest = await (await fetch("/audio/manifest.json")).json();
    const provenance = await (await fetch("/audio/gemini/provenance.json")).json();
    const compression = await (await fetch("/audio/gemini/compression.json")).json();
    const context = new AudioContext();
    const clips = [];
    try {
      for (const [format, hours] of [["12h", manifest.hours], ["24h", manifest.hours24]] as const) {
        for (let h = 0; h < 24; h++) {
          const hour = String(h).padStart(2, "0");
          const url = hours[hour].url;
          const response = await fetch(url);
          if (!response.ok) throw Error(`${url}: ${response.status}`);
          const audio = await context.decodeAudioData(await response.arrayBuffer());
          const original = provenance.assets.find((a: { format: string; hour: string }) => a.format === format && a.hour === hour);
          clips.push({ url, format, duration: audio.duration, expected: original.duration_seconds, channels: audio.numberOfChannels, mime: response.headers.get("content-type") });
        }
      }
      return { clips, chime: manifest.chime.url, compressionCount: compression.assets.length };
    } finally { await context.close(); }
  });
  expect(result.clips).toHaveLength(48);
  expect(result.compressionCount).toBe(48);
  expect(result.chime).toBe("/audio/chime_Eb5_C5_Eb5_Ab5.wav");
  for (const clip of result.clips) {
    expect(clip.url).toMatch(/^\/audio\/gemini\/(12h|24h)\/hour-\d{2}\.ogg$/);
    expect(clip.channels).toBe(1);
    expect(Math.abs(clip.duration - clip.expected)).toBeLessThan(0.001);
    expect(clip.mime).toMatch(/(?:audio|application)\/ogg/);
  }
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  });
  await page.context().setOffline(true);
  try {
    const offline = await page.evaluate(async () => {
      const m = await (await fetch("/audio/manifest.json")).json();
      let count = 0;
      for (const set of [m.hours, m.hours24]) for (const asset of Object.values(set) as { url: string }[]) {
        const r = await fetch(asset.url);
        if (r.ok && (await r.arrayBuffer()).byteLength > 0) count++;
      }
      return count;
    });
    expect(offline).toBe(48);
  } finally { await page.context().setOffline(false); }
});
