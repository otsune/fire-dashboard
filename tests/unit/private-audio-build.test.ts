import { createAudioController } from "../../apps/dashboard/src/audio/controller";
import { parseSettings } from "../../packages/contracts/src/index";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  readPrivateAudio,
  installPrivateAudio,
  parsePrivateAudioArgs,
  preparePrivateAudio,
} from "../../scripts/build-private-audio";
import {
  modeReady,
  parseManifest,
} from "../../apps/dashboard/src/audio/manifest";

let root: string;
let source: string;
const license = "Synthetic test fixture only; no real voice assets";
const chime = {
  url: "/audio/chime_Eb5_C5_Eb5_Ab5.wav",
  license: "Unlicense; original synthesized chime",
};
const hours = (extension = "mp3") =>
  Object.fromEntries(
    Array.from({ length: 24 }, (_, hour) => {
      const key = String(hour).padStart(2, "0");
      return [key, { url: `/audio/hour-${key}.${extension}`, license }];
    }),
  );
async function manifest(value: unknown = { hours: hours(), chime: null }) {
  await writeFile(join(source, "manifest.json"), JSON.stringify(value));
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fire-private-audio-test-"));
  source = join(root, "source");
  await mkdir(source);
  await manifest();
  for (let hour = 0; hour < 24; hour++) {
    // Deliberately not real MP3 audio; installer checks layout, not decoding.
    await writeFile(
      join(source, `hour-${String(hour).padStart(2, "0")}.mp3`),
      `synthetic-hour-${hour}`,
    );
  }
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("imports all hours into private output, preserving licenses and the bundled chime", async () => {
  const bundle = await readPrivateAudio(source);
  const output = join(root, "dist", "audio");
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify({ hours: {}, chime }),
  );
  await writeFile(
    join(source, "provenance.json"),
    "private metadata must stay out of output",
  );
  await installPrivateAudio(bundle, output);
  const deployed = parseManifest(
    JSON.parse(await readFile(join(output, "manifest.json"), "utf8")),
  );
  expect(modeReady(deployed, "both")).toBe(true);
  expect(modeReady(deployed, "voice", false)).toBe(false);
  expect(deployed.chime).toEqual(chime);
  for (let hour = 0; hour < 24; hour++) {
    const key = String(hour).padStart(2, "0");
    expect(deployed.hours[key]).toEqual({
      url: `/audio/private/hour-${key}.mp3`,
      license,
    });
    expect(
      await readFile(join(output, "private", `hour-${key}.mp3`), "utf8"),
    ).toBe(`synthetic-hour-${hour}`);
  }
  await expect(readFile(join(output, "provenance.json"))).rejects.toThrow();
  expect(
    JSON.parse(await readFile(join(source, "manifest.json"), "utf8")).chime,
  ).toBeNull();
});
it("rejects a missing hour instead of installing a partial voice set", async () => {
  const value = hours();
  delete value["23"];
  await manifest({ hours: value, chime: null });
  await expect(readPrivateAudio(source)).rejects.toThrow(/24/);
});
it("rejects a missing source file before the build", async () => {
  await rm(join(source, "hour-23.mp3"));
  await expect(readPrivateAudio(source)).rejects.toThrow(/hour-23/);
});
it("rejects an empty source file", async () => {
  await writeFile(join(source, "hour-00.mp3"), "");
  await expect(readPrivateAudio(source)).rejects.toThrow(/empty|size/i);
});
it.each([
  "/audio/../secret.mp3",
  "https://example.com/voice.mp3",
  "/audio/hour-01.mp3",
  "/audio/hour-01.wav",
  "/audio/hour-00.ogg",
  "/audio/hour-00.MP3",
  "/audio/hour-00.wav?download=1",
  "/audio/nested/hour-00.wav",
  "/audio/hour-00%2ewav",
  "/audio/../hour-00.wav",
])("rejects unsafe or mismatched input URL %s", async (url) => {
  const value = hours();
  value["00"].url = url;
  await manifest({ hours: value, chime: null });
  await expect(readPrivateAudio(source)).rejects.toThrow();
});
it("rejects missing license metadata", async () => {
  const value = hours();
  value["00"].license = "";
  await manifest({ hours: value, chime: null });
  await expect(readPrivateAudio(source)).rejects.toThrow();
});
it.skipIf(process.platform === "win32")(
  "rejects symlinked voice files",
  async () => {
    await rm(join(source, "hour-00.mp3"));
    await symlink(join(source, "hour-01.mp3"), join(source, "hour-00.mp3"));
    await expect(readPrivateAudio(source)).rejects.toThrow(/regular|symlink/i);
  },
);
it("rejects an oversized manifest", async () => {
  await writeFile(join(source, "manifest.json"), " ".repeat(65537));
  await expect(readPrivateAudio(source)).rejects.toThrow(/size|large/i);
});

// An in-repository source could be copied by Vite before the private overlay.
it.each([".", "apps/dashboard/public/audio"])(
  "CLI rejects input inside the repository: %s",
  (path) => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/build-private-audio.ts", resolve(path)],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outside the repository");
  },
);
it("CLI resolves symlinks before enforcing the external-source boundary", async () => {
  const alias = join(root, "alias");
  await symlink(resolve("apps/dashboard/public/audio"), alias, "junction");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/build-private-audio.ts", alias],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("outside the repository");
});

it("plays the bundled chime, 300 ms gap, then the imported hour at midnight and 23:00", async () => {
  const output = join(root, "dist", "audio");
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify({ hours: {}, chime }),
  );
  await installPrivateAudio(await readPrivateAudio(source), output);
  const deployed = parseManifest(
    JSON.parse(await readFile(join(output, "manifest.json"), "utf8")),
  );
  const sequence: (string | number)[] = [];
  const controller = createAudioController(
    () => parseSettings({ audioMode: "both", hour12: true }),
    deployed,
    {
      play: async (url) => {
        sequence.push(url);
      },
      delay: async (ms) => {
        sequence.push(ms);
      },
    },
  );
  try {
    expect(controller.state().enabled).toBe(false);
    expect(await controller.enable()).toBe(true);
    await controller.preview(23);
    expect(sequence).toEqual([
      chime.url,
      300,
      "/audio/private/hour-00.mp3",
      chime.url,
      300,
      "/audio/private/hour-23.mp3",
    ]);
  } finally {
    controller.dispose();
  }
});

function nativePcmWav(hour: number): Buffer {
  // Synthetic 24 kHz mono PCM16 samples, never a provider-generated voice.
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(4, 40);
  bytes.writeInt16LE(hour * 100, 44);
  bytes.writeInt16LE(-hour * 100, 46);
  return bytes;
}

async function wavSource(): Promise<string> {
  const directory = join(root, "native-wav-source");
  await mkdir(directory);
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ hours: hours("wav"), chime: null, format: "24h" }),
  );
  for (let hour = 0; hour < 24; hour++) {
    await writeFile(
      join(directory, `hour-${String(hour).padStart(2, "0")}.wav`),
      nativePcmWav(hour),
    );
  }
  return directory;
}

async function audioOutput(): Promise<string> {
  const output = join(root, "dist", "audio");
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify({ hours: {}, chime }),
  );
  return output;
}

it("preserves native 24 kHz PCM16 WAV bytes when installing the 24h set", async () => {
  const nativeSource = await wavSource();
  const output = await audioOutput();
  await installPrivateAudio(
    await readPrivateAudio(nativeSource),
    output,
    "24h",
  );
  const deployed = parseManifest(
    JSON.parse(await readFile(join(output, "manifest.json"), "utf8")),
  );
  expect(deployed.hours).toEqual({});
  expect(deployed.chime).toEqual(chime);
  expect(modeReady(deployed, "voice")).toBe(false);
  expect(modeReady(deployed, "both", false)).toBe(true);
  for (let hour = 0; hour < 24; hour++) {
    const key = String(hour).padStart(2, "0");
    expect(deployed.hours24?.[key]).toEqual({
      url: `/audio/private/24h/hour-${key}.wav`,
      license,
    });
    expect(
      await readFile(join(output, "private", "24h", `hour-${key}.wav`)),
    ).toEqual(nativePcmWav(hour));
  }
  await expect(
    readFile(join(output, "private", "hour-00.wav")),
  ).rejects.toThrow();
});

it("installs distinct 12h MP3 and 24h WAV sets without replacing either format", async () => {
  const nativeSource = await wavSource();
  const bundles = await preparePrivateAudio({
    "12h": source,
    "24h": nativeSource,
  });
  const output = await audioOutput();
  await installPrivateAudio(bundles["24h"]!, output, "24h");
  await installPrivateAudio(bundles["12h"]!, output);
  const deployed = parseManifest(
    JSON.parse(await readFile(join(output, "manifest.json"), "utf8")),
  );
  expect(modeReady(deployed, "both")).toBe(true);
  expect(modeReady(deployed, "both", false)).toBe(true);
  expect(deployed.hours["23"].url).toBe("/audio/private/hour-23.mp3");
  expect(deployed.hours24?.["23"].url).toBe("/audio/private/24h/hour-23.wav");
  expect(await readFile(join(output, "private", "hour-23.mp3"), "utf8")).toBe(
    "synthetic-hour-23",
  );
  expect(await readFile(join(output, "private", "24h", "hour-23.wav"))).toEqual(
    nativePcmWav(23),
  );
});

it("uses the explicit destination format rather than optional source metadata", async () => {
  const nativeSource = await wavSource();
  const output = await audioOutput();
  await installPrivateAudio(await readPrivateAudio(nativeSource), output);
  const deployed = parseManifest(
    JSON.parse(await readFile(join(output, "manifest.json"), "utf8")),
  );
  expect(modeReady(deployed, "voice")).toBe(true);
  expect(modeReady(deployed, "voice", false)).toBe(false);
  expect(deployed.hours["00"].url).toBe("/audio/private/hour-00.wav");
  expect(deployed.hours24 ?? {}).toEqual({});
});

it("allows either supported extension per manifest entry", async () => {
  const value = hours();
  value["00"].url = "/audio/hour-00.wav";
  await manifest({ hours: value, chime: null });
  await writeFile(join(source, "hour-00.wav"), nativePcmWav(0));
  await rm(join(source, "hour-00.mp3"));
  const output = await audioOutput();
  await installPrivateAudio(await readPrivateAudio(source), output, "24h");
  const deployed = parseManifest(
    JSON.parse(await readFile(join(output, "manifest.json"), "utf8")),
  );
  expect(deployed.hours24?.["00"].url).toBe("/audio/private/24h/hour-00.wav");
  expect(deployed.hours24?.["01"].url).toBe("/audio/private/24h/hour-01.mp3");
});

it("rejects an incomplete 24h source even when the 12h set is complete", async () => {
  const nativeSource = await wavSource();
  const value = hours("wav");
  delete value["23"];
  await writeFile(
    join(nativeSource, "manifest.json"),
    JSON.stringify({ hours: value, chime: null }),
  );
  await expect(
    preparePrivateAudio({ "12h": source, "24h": nativeSource }),
  ).rejects.toThrow(/24/);
});

it("rejects a missing WAV file instead of falling back to the 12h set", async () => {
  const nativeSource = await wavSource();
  await rm(join(nativeSource, "hour-23.wav"));
  await expect(
    preparePrivateAudio({ "12h": source, "24h": nativeSource }),
  ).rejects.toThrow(/hour-23.wav/);
});

it.each([
  ["legacy positional", ["/private/twelve"], { "12h": "/private/twelve" }],
  ["12h flag", ["--12h", "/private/twelve"], { "12h": "/private/twelve" }],
  [
    "24h flag",
    ["--24h", "/private/twenty-four"],
    { "24h": "/private/twenty-four" },
  ],
  [
    "both flags",
    ["--12h", "/private/twelve", "--24h", "/private/twenty-four"],
    { "12h": "/private/twelve", "24h": "/private/twenty-four" },
  ],
  [
    "reverse flag order",
    ["--24h", "/private/twenty-four", "--12h", "/private/twelve"],
    { "12h": "/private/twelve", "24h": "/private/twenty-four" },
  ],
])("parses private build sources: %s", (_label, args, expected) => {
  expect(parsePrivateAudioArgs(args)).toEqual(expected);
});

it.each(
  [
    [],
    ["--12h"],
    ["--24h"],
    ["--12h", "--24h", "/private/source"],
    ["--12h", ""],
    ["--unknown", "/private/source"],
    ["--24h=/private/source"],
    ["--12h", "/private/one", "--12h", "/private/two"],
    ["--24h", "/private/one", "--24h", "/private/two"],
    ["/private/one", "/private/two"],
    ["/private/one", "--24h", "/private/two"],
    ["--24h", "/private/one", "unexpected"],
  ].map((args) => ({ args })),
)("rejects malformed private build arguments $args", ({ args }) => {
  expect(() => parsePrivateAudioArgs(args)).toThrow(
    /Usage|source|argument|format/i,
  );
});

it("validates every source realpath before reading either audio set", async () => {
  await rm(join(source, "hour-00.mp3"));
  await expect(
    preparePrivateAudio({ "12h": source, "24h": resolve(".") }),
  ).rejects.toThrow(/outside the repository/);
});

it.each(["--12h", "--24h"])(
  "CLI rejects repository sources selected with %s",
  (flag) => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/build-private-audio.ts", flag, resolve(".")],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("outside the repository");
  },
);

it.each(["12h", "24h"] as const)(
  "prepares only the explicitly selected %s source",
  async (format) => {
    const bundles = await preparePrivateAudio({ [format]: source });
    expect(Object.keys(bundles)).toEqual([format]);
    expect(bundles[format]).toHaveLength(24);
  },
);

it("rejects missing license metadata in the 24h set", async () => {
  const nativeSource = await wavSource();
  const value = hours("wav");
  value["00"].license = "";
  await writeFile(
    join(nativeSource, "manifest.json"),
    JSON.stringify({ hours: value, chime: null }),
  );
  await expect(
    preparePrivateAudio({ "12h": source, "24h": nativeSource }),
  ).rejects.toThrow(/license/);
});

it("overrides only the selected format while retaining the bundled other set", async () => {
  const bundled = JSON.parse(
    await readFile("apps/dashboard/public/audio/manifest.json", "utf8"),
  );
  expect(modeReady(bundled, "voice", false)).toBe(true);
  const output = join(root, "dist", "audio");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "manifest.json"), JSON.stringify(bundled));
  await installPrivateAudio(await readPrivateAudio(source), output, "12h");
  const deployed = JSON.parse(
    await readFile(join(output, "manifest.json"), "utf8"),
  );
  expect(deployed.hours24).toEqual(bundled.hours24);
  expect(deployed.chime).toEqual(bundled.chime);
  expect(deployed.hours["00"].url).toBe("/audio/private/hour-00.mp3");
});
