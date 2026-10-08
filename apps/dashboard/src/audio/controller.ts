import type { AppSettings } from "../../../../packages/contracts/src/index";
import type { HourDecision } from "../clock/hourly";
import { isQuiet } from "../clock/hourly";
import { claimHour, acquireLease, renewLease, releaseLease } from "./claims";
import { modeReady, type AudioManifest } from "./manifest";
import { withBrowserAudioLock } from "./browser-lock";
type Dependencies = {
  play?: (url: string, volume: number, signal: AbortSignal) => Promise<void>;
  delay?: (ms: number) => Promise<void>;
  claim?: typeof claimHour;
  now?: () => number;
  monoNow?: () => number;
  visible?: () => boolean;
};
export function playAsset(
  url: string,
  volume: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    audio.volume = volume;
    let timer: ReturnType<typeof setTimeout>;
    const end = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      error ? reject(error) : resolve();
    };
    const abort = () => end(Error("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    audio.onended = () => end();
    audio.onerror = () => end(Error("audio_failed"));
    timer = setTimeout(() => end(Error("audio_timeout")), 20000);
    audio.play().catch(() => end(Error("play_denied")));
  });
}
export function createAudioController(
  settings: () => AppSettings,
  manifest: AudioManifest,
  deps: Dependencies = {},
) {
  const owner = crypto.randomUUID();
  const now = deps.now ?? (() => Date.now()),
    monoNow = deps.monoNow ?? (() => performance.now()),
    visible =
      deps.visible ??
      (() => typeof document === "undefined" || !document.hidden);
  const play = deps.play ?? playAsset,
    delay = deps.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let enabled = false,
    message = "音源未設定",
    active: "hourly" | "preview" | null = null;
  let abort: AbortController | null = null,
    running: Promise<boolean> | null = null,
    generation = 0;
  const channel =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("fire-audio-v1")
      : null;
  function stop() {
    generation++;
    abort?.abort();
    return (running ?? Promise.resolve()).then(
      () => {},
      () => {},
    );
  }
  if (channel)
    channel.onmessage = (e) => {
      if (e.data === "stop-preview" && active === "preview") void stop();
    };
  function ready() {
    const s = settings();
    return modeReady(manifest, s.audioMode, s.hour12);
  }
  function unavailableMessage() {
    const s = settings();
    if (s.audioMode === "off") return "時報は無音";
    if (
      (s.audioMode === "voice" || s.audioMode === "both") &&
      !modeReady(manifest, "voice", s.hour12)
    )
      return `${s.hour12 ? 12 : 24}時間表記の音声が未設定`;
    return "チャイム未設定";
  }
  async function settingsChanged() {
    const wasEnabled = enabled;
    const stopped = stop();
    const ticket = generation;
    if (!ready()) {
      enabled = false;
      message = unavailableMessage();
    }
    await stopped;
    // A later tap, disable, or settings change owns the new state.
    if (ticket !== generation) return;
    enabled = wasEnabled && ready();
    message = ready()
      ? enabled
        ? "音声有効"
        : "音声無効"
      : unavailableMessage();
  }
  function run(
    hour: number,
    kind: "hourly" | "preview",
    permit: () => boolean = () => true,
  ): Promise<boolean> {
    if (kind === "preview" && active === "hourly")
      return Promise.resolve(false);
    const ticket = ++generation;
    abort?.abort();
    const preceding = running;
    const job = (async () => {
      await preceding?.catch(() => {});
      if (ticket !== generation || !permit()) return false;
      if (kind === "hourly") {
        channel?.postMessage("stop-preview");
        await delay(150);
      }
      if (ticket !== generation || !permit()) return false;
      let entered = false;
      const played = await withBrowserAudioLock(async (exclusive) => {
        entered = true;
        if (!(await acquireLease(owner, kind, now(), exclusive))) {
          message = "別の画面で音声を再生中";
          return false;
        }
        if (ticket !== generation || !permit()) {
          await releaseLease(owner);
          return false;
        }
        active = kind;
        const controller = new AbortController();
        abort = controller;
        const leaseTimer = setInterval(() => {
          void renewLease(owner, now())
            .then((ok) => {
              if (!ok) {
                enabled = false;
                message = "再生権を確認できません";
                void stop();
              }
            })
            .catch(() => {
              enabled = false;
              message = "再生権を保存できません";
              void stop();
            });
        }, 5000);
        try {
          const s = settings();
          if (s.audioMode === "chime" || s.audioMode === "both")
            await play(
              (hour % 2 === 1
                ? (manifest.chimeOdd ?? manifest.chime!)
                : manifest.chime!
              ).url,
              s.volume,
              controller.signal,
            );
          if (s.audioMode === "both") {
            await delay(300);
            if (controller.signal.aborted || !permit())
              throw Error("cancelled");
          }
          if (s.audioMode === "voice" || s.audioMode === "both")
            await play(
              (s.hour12 ? manifest.hours : manifest.hours24!)[
                String(hour).padStart(2, "0")
              ].url,
              s.volume,
              controller.signal,
            );
          return !controller.signal.aborted;
        } finally {
          clearInterval(leaseTimer);
          active = null;
          abort = null;
          await releaseLease(owner);
        }
      });
      if (!entered && ticket === generation) message = "別の画面で音声を再生中";
      return played;
    })();
    running = job;
    return job;
  }
  async function enable() {
    if (!ready()) {
      enabled = false;
      message = unavailableMessage();
      return false;
    }
    try {
      enabled = await run(0, "preview");
      message = enabled ? "音声有効" : message;
      return enabled;
    } catch {
      enabled = false;
      message = "音声を再生できません。もう一度タップしてください";
      return false;
    }
  }
  async function preview(hour: number) {
    if (!ready()) return;
    try {
      await run(hour, "preview");
    } catch {
      enabled = false;
      message = "音声を再生できません。もう一度タップしてください";
    }
  }
  async function announce(decision: HourDecision) {
    if (!enabled || decision.key === null || decision.hour === null) return;
    const s = settings(),
      signature = JSON.stringify(s),
      intent = generation;
    const startedWall = now(),
      startedMono = monoNow();
    const deadline = decision.expiresAt ?? startedWall + 10000;
    const permit = () => {
      const wall = now(),
        elapsed = monoNow() - startedMono;
      return (
        enabled &&
        visible() &&
        wall <= deadline &&
        wall >= startedWall &&
        elapsed >= 0 &&
        elapsed <= deadline - startedWall &&
        Math.abs(wall - startedWall - elapsed) <= 2000 &&
        JSON.stringify(settings()) === signature &&
        ready() &&
        !isQuiet(wall, settings())
      );
    };
    if (!permit()) {
      await stop();
      return;
    }
    try {
      if (!(await (deps.claim ?? claimHour)(decision.key))) return;
    } catch {
      enabled = false;
      message = "時報の記録を保存できません";
      await stop();
      return;
    }
    if (intent !== generation || !permit()) return;
    try {
      if (await run(decision.hour, "hourly", permit)) message = "音声有効";
    } catch {
      enabled = false;
      message = "音声を再生できません。もう一度タップしてください";
    }
  }
  return {
    enable,
    preview,
    announce,
    stop,
    settingsChanged,
    disable: () => {
      enabled = false;
      message = "音声無効";
      void stop();
    },
    state: () => ({
      enabled: enabled && ready(),
      message: ready() ? message : unavailableMessage(),
      ready: ready(),
    }),
    dispose: () => {
      enabled = false;
      void stop();
      channel?.close();
    },
  };
}
