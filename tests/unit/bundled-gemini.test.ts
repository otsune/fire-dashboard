import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  parseManifest,
  modeReady,
} from "../../apps/dashboard/src/audio/manifest";
import { createAudioController } from "../../apps/dashboard/src/audio/controller";
import { parseSettings } from "../../packages/contracts/src/index";

it("bundles both complete Ogg sets while retaining original PCM and provenance", async () => {
  const manifest = parseManifest(
    JSON.parse(
      await readFile("apps/dashboard/public/audio/manifest.json", "utf8"),
    ),
  );
  expect(modeReady(manifest, "both", true)).toBe(true);
  expect(modeReady(manifest, "both", false)).toBe(true);
  const provenance = JSON.parse(
    await readFile(
      "apps/dashboard/public/audio/gemini/provenance.json",
      "utf8",
    ),
  );
  expect(provenance.assets).toHaveLength(48);
  for (const [format, hours] of [
    ["12h", manifest.hours],
    ["24h", manifest.hours24!],
  ] as const) {
    expect(Object.keys(hours)).toHaveLength(24);
    expect(
      (await readdir(`apps/dashboard/public/audio/gemini/${format}`)).sort(),
    ).toEqual(
      Array.from(
        { length: 24 },
        (_, h) => ["ogg", "wav"].map(ext => `hour-${String(h).padStart(2, "0")}.${ext}`),
      ).flat().sort(),
    );
    for (let hour = 0; hour < 24; hour++) {
      const key = String(hour).padStart(2, "0");
      const path = `${format}/hour-${key}.wav`;
      const asset = hours[key];
      expect(asset.url).toBe(`/audio/gemini/${path.replace(".wav", ".ogg")}`);
      const ogg = await readFile(`apps/dashboard/public${asset.url}`);
      expect(ogg.toString("ascii", 0, 4)).toBe("OggS");
      expect(ogg.includes(Buffer.from("OpusHead"))).toBe(true);
      expect(asset.license).toContain("/audio/gemini/NOTICE.txt");
      expect(asset.license).not.toMatch(
        /private.only|non.commercial|elevenlabs/i,
      );
      const wav = await readFile(`apps/dashboard/public/audio/gemini/${path}`);
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.readUInt16LE(20)).toBe(1);
      expect(wav.readUInt16LE(22)).toBe(1);
      expect(wav.readUInt32LE(24)).toBe(24000);
      expect(wav.readUInt16LE(34)).toBe(16);
      expect(wav.length).toBe(wav.readUInt32LE(40) + 44);
      const record = provenance.assets.find(
        (a: { path: string }) => a.path === path,
      );
      expect(record).toMatchObject({
        format,
        hour: key,
        sample_rate_hz: 24000,
        channels: 1,
        bits_per_sample: 16,
      });
      expect(record.sha256).toBe(
        createHash("sha256").update(wav).digest("hex"),
      );
      expect(record.duration_seconds).toBeCloseTo(
        wav.readUInt32LE(40) / 48000,
        5,
      );
      const expectedText =
        format === "24h"
          ? `${hour}時です。`
          : `${hour < 12 ? "午前" : "午後"}${hour % 12 || 12}時です。`;
      expect(record.expected_text).toBe(expectedText);
    }
  }
});

it.each([true, false])(
  "keeps bundled speech disabled before a tap when hour12=%s",
  async (hour12) => {
    const manifest = parseManifest(
      JSON.parse(
        await readFile("apps/dashboard/public/audio/manifest.json", "utf8"),
      ),
    );
    const played: string[] = [];
    const controller = createAudioController(
      () => parseSettings({ hour12 }),
      manifest,
      {
        play: async (url) => {
          played.push(url);
        },
      },
    );
    try {
      expect(controller.state()).toMatchObject({ ready: true, enabled: false });
      expect(played).toEqual([]);
      expect(await controller.enable()).toBe(true);
      expect(played).toEqual([
        `/audio/gemini/${hour12 ? "12h" : "24h"}/hour-00.ogg`,
      ]);
    } finally {
      controller.dispose();
    }
  },
);
