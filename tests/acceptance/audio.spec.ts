import { test, expect, type BrowserContext, type Page } from "@playwright/test";
for (const hour of [0, 1, 12, 23]) {
  test(`bundled chime selects the correct asset at ${hour}:00`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const played: string[] = [];
      (window as unknown as { testPlayed: string[] }).testPlayed = played;
      class FixtureAudio {
        onended: (() => void) | null = null;
        constructor(private src: string) {}
        play() {
          played.push(this.src);
          Promise.resolve().then(() => this.onended?.());
          return Promise.resolve();
        }
        pause() {}
        removeAttribute() {}
        load() {}
      }
      Object.defineProperty(window, "Audio", { value: FixtureAudio });
    });
    const boundary = Date.parse(
      `2026-10-10T${String(hour).padStart(2, "0")}:00:00+09:00`,
    );
    await page.clock.install({ time: new Date(boundary - 5000) });
    await page.goto("/");
    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByLabel("時報の種類").selectOption("chime");
    await page.getByRole("button", { name: "時計に戻る" }).click();
    await page.getByRole("button", { name: "音声を有効にする" }).click();
    await expect(page.getByText("音声有効", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { testPlayed: string[] }).testPlayed.length = 0;
    });
    await page.clock.runFor(6500);
    const expected =
      hour % 2 === 0
        ? "/audio/chime_Eb5_C5_Eb5_Ab5.ogg"
        : "/audio/chime_NRT.ogg";
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { testPlayed: string[] }).testPlayed,
        ),
      )
      .toEqual([expected]);
    const duration = await page.evaluate(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw Error(`audio fetch failed: ${response.status}`);
      const context = new AudioContext();
      try {
        return (await context.decodeAudioData(await response.arrayBuffer()))
          .duration;
      } finally {
        await context.close();
      }
    }, expected);
    expect(duration).toBeGreaterThan(0);
  });
}

/** Held synthetic media exercises production arbitration, not real audio or Fire compatibility. */
async function installHeldAudio(context: BrowserContext) {
  const playback = {
    active: new Set<string>(),
    maximum: 0,
    urls: [] as string[],
  };
  await context.exposeBinding(
    "recordTestAudio",
    (_source, event: { kind: "start" | "end"; id: string; url: string }) => {
      if (event.kind === "start") {
        playback.active.add(event.id);
        playback.urls.push(event.url);
        playback.maximum = Math.max(playback.maximum, playback.active.size);
      } else playback.active.delete(event.id);
    },
  );
  await context.route("**/audio/manifest.json", (route) =>
    route.fulfill({
      json: {
        hours: {},
        hours24: Object.fromEntries(
          Array.from({ length: 24 }, (_, h) => [
            String(h).padStart(2, "0"),
            { url: `/audio/${h}.mp3`, license: "acceptance fixture only" },
          ]),
        ),
        chime: null,
      },
    }),
  );
  await context.addInitScript(() => {
    const fixture = window as unknown as {
      testPlayed: string[];
      testFinishAudio: () => Promise<void>;
      recordTestAudio: (event: {
        kind: "start" | "end";
        id: string;
        url: string;
      }) => Promise<void>;
    };
    const played: string[] = [];
    fixture.testPlayed = played;
    let current: FixtureAudio | null = null;
    class FixtureAudio {
      id = crypto.randomUUID();
      active = false;
      volume = 1;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public src: string) {}
      async play() {
        this.active = true;
        current = this;
        played.push(this.src);
        await fixture.recordTestAudio({
          kind: "start",
          id: this.id,
          url: this.src,
        });
      }
      async finish(ended = true) {
        if (!this.active) return;
        this.active = false;
        await fixture.recordTestAudio({
          kind: "end",
          id: this.id,
          url: this.src,
        });
        if (ended) this.onended?.();
      }
      pause() {
        void this.finish(false);
      }
      removeAttribute() {}
      load() {}
    }
    fixture.testFinishAudio = async () => {
      await current?.finish();
    };
    Object.defineProperty(window, "Audio", { value: FixtureAudio });
  });
  return playback;
}
async function played(page: Page) {
  return page.evaluate(
    () => (window as unknown as { testPlayed: string[] }).testPlayed,
  );
}
async function finishAudio(page: Page) {
  await page.evaluate(() =>
    (
      window as unknown as { testFinishAudio: () => Promise<void> }
    ).testFinishAudio(),
  );
}
async function enableAudio(page: Page) {
  const before = (await played(page)).length;
  await page.getByRole("button", { name: "音声を有効にする" }).click();
  await expect.poll(async () => (await played(page)).length).toBe(before + 1);
  await finishAudio(page);
  await expect(page.getByText("音声有効", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "音声を無効にする" }),
  ).toBeEnabled();
}
async function claimKeys(page: Page) {
  return page.evaluate(async () => {
    const request = indexedDB.open("fire-dashboard-v1", 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<string[]>((resolve, reject) => {
        const tx = db.transaction("claims", "readonly");
        const request = tx.objectStore("claims").getAll();
        request.onsuccess = () =>
          resolve(request.result.map((value: { key: string }) => value.key));
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });
}

test.describe("synthetic audio arbitration", () => {
  // A controlling worker can serve the bundled manifest without reaching the
  // route fixture, especially after reload. Keep only these synthetic tests
  // off that cache path; production offline and real chime tests keep workers.
  test.use({ serviceWorkers: "block" });

  test("production controller claims one hour across two enabled tabs and reload", async ({
    context,
  }) => {
    const playback = await installHeldAudio(context);
    const pages = [await context.newPage(), await context.newPage()];
    // Playwright's clock belongs to the context. Install, pause and advance it
    // through one page so both controllers observe the same normal clock ticks.
    await pages[0].clock.install({ time: new Date("2026-10-02T00:59:00Z") });
    await Promise.all(
      pages.map(async (page) => {
        await page.goto("/");
        await expect(
          page.getByRole("button", { name: "音声を有効にする" }),
        ).toBeEnabled();
      }),
    );
    await pages[0].clock.pauseAt(new Date("2026-10-02T00:59:55Z"));
    for (const page of pages) await enableAudio(page);
    for (const page of pages) {
      await expect(page.getByText("音声有効", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("button", { name: "音声を無効にする" }),
      ).toBeEnabled();
    }
    expect(playback.urls).toEqual(["/audio/0.mp3", "/audio/0.mp3"]);
    expect(await claimKeys(pages[0])).toEqual([]);
    await pages[0].clock.runFor(6500);
    await expect
      .poll(() => playback.urls.filter((url) => url === "/audio/10.mp3").length)
      .toBe(1);
    const histories = await Promise.all(pages.map(played));
    expect(
      histories.flat().filter((url) => url === "/audio/10.mp3"),
    ).toHaveLength(1);
    expect(await claimKeys(pages[0])).toEqual(["Asia/Tokyo|2026-10-02|10"]);
    const hourlyPage =
      pages[histories.findIndex((urls) => urls.includes("/audio/10.mp3"))];
    await finishAudio(hourlyPage);
    await expect.poll(() => playback.active.size).toBe(0);
    expect(playback.maximum).toBe(1);
    await pages[0].reload();
    await expect(
      pages[0].getByRole("button", { name: "音声を有効にする" }),
    ).toBeEnabled();
    await expect(
      pages[0].getByRole("button", { name: "音声を無効にする" }),
    ).toHaveCount(0);
    await pages[0].clock.runFor(1000);
    expect(await played(pages[0])).toEqual([]);
    expect(await claimKeys(pages[0])).toEqual(["Asia/Tokyo|2026-10-02|10"]);
    // A fresh tap is allowed, but the persisted hourly attempt never replays.
    await enableAudio(pages[0]);
    await pages[0].clock.runFor(1000);
    expect(await played(pages[0])).toEqual(["/audio/0.mp3"]);
    expect(playback.urls.filter((url) => url === "/audio/10.mp3")).toHaveLength(
      1,
    );
    expect(await claimKeys(pages[0])).toEqual(["Asia/Tokyo|2026-10-02|10"]);
    expect(playback.maximum).toBe(1);
  });

  test("a contending enable stays disabled until an explicit retry after exclusive preview release", async ({
    context,
  }) => {
    const playback = await installHeldAudio(context);
    const pages = [await context.newPage(), await context.newPage()];
    await pages[0].clock.install({ time: new Date("2026-10-02T00:59:00Z") });
    await Promise.all(
      pages.map(async (page) => {
        await page.goto("/");
        await expect(
          page.getByRole("button", { name: "音声を有効にする" }),
        ).toBeEnabled();
      }),
    );
    await pages[0].clock.pauseAt(new Date("2026-10-02T00:59:55Z"));
    await pages[0].getByRole("button", { name: "音声を有効にする" }).click();
    await expect.poll(() => playback.active.size).toBe(1);
    await pages[1].getByRole("button", { name: "音声を有効にする" }).click();
    await expect(
      pages[1].getByText("別の画面で音声を再生中", { exact: true }),
    ).toBeVisible();
    await expect(
      pages[1].getByRole("button", { name: "音声を有効にする" }),
    ).toBeEnabled();
    await expect(
      pages[1].getByRole("button", { name: "音声を無効にする" }),
    ).toHaveCount(0);
    expect(await played(pages[1])).toEqual([]);
    expect(playback.urls).toEqual(["/audio/0.mp3"]);
    expect(playback.maximum).toBe(1);
    await finishAudio(pages[0]);
    await expect(pages[0].getByText("音声有効", { exact: true })).toBeVisible();
    expect(playback.active.size).toBe(0);
    await pages[0].clock.runFor(1000);
    await expect(
      pages[1].getByRole("button", { name: "音声を有効にする" }),
    ).toBeEnabled();
    await expect(
      pages[1].getByRole("button", { name: "音声を無効にする" }),
    ).toHaveCount(0);
    expect(await played(pages[1])).toEqual([]);
    expect(playback.urls).toEqual(["/audio/0.mp3"]);
    await enableAudio(pages[1]);
    expect(playback.urls).toEqual(["/audio/0.mp3", "/audio/0.mp3"]);
    expect(playback.maximum).toBe(1);
    expect(playback.active.size).toBe(0);
    expect(await claimKeys(pages[0])).toEqual([]);
  });
});

test("bundled original chime decodes and plays only after an explicit tap", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "音声を有効にする" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "音声を無効にする" }),
  ).toHaveCount(0);
  const decoded = await page.evaluate(async () => {
    const response = await fetch("/audio/chime_Eb5_C5_Eb5_Ab5.wav");
    const context = new AudioContext();
    try {
      const audio = await context.decodeAudioData(await response.arrayBuffer());
      return { duration: audio.duration, channels: audio.numberOfChannels };
    } finally {
      await context.close();
    }
  });
  expect(decoded.duration).toBeCloseTo(3.2, 2);
  expect(decoded.channels).toBe(1);
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "時計・音声", exact: true }),
  ).toBeFocused();
  await page.getByLabel("時報の種類").selectOption("chime");
  await page.getByRole("button", { name: "時計に戻る" }).click();
  await expect(
    page.getByRole("button", { name: "音声を有効にする" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "音声を有効にする" }).click();
  await expect(page.getByText("音声有効", { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "音声を有効にする" }),
  ).toBeEnabled();
});
