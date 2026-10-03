import { useEffect, useRef, useState } from "react";
import { Clock } from "./clock/Clock";
import { Settings } from "./settings/Settings";
import { WeatherSettings } from "./settings/WeatherSettings";
import { loadSettings, saveSettings } from "./settings/store";
import {
  emptyDashboard,
  type Dashboard,
  type Weather,
} from "../../../packages/contracts/src/index";
import { WeatherCard } from "./cards/WeatherCard";
import { UsageCard } from "./cards/UsageCard";
import { AdditionalUsageCards } from "./cards/AdditionalUsageCards";
import { RssCard } from "./cards/RssCard";
import { fetchDashboard } from "./data/client";
import {
  invalidateDashboardCache,
  loadDashboard,
  mergeDashboard,
  saveDashboard,
} from "./data/cache";
import { loadManifest } from "./audio/manifest";
import { createAudioController } from "./audio/controller";
import { AudioControls } from "./audio/Controls";
import { evaluateHour, isQuiet, type Tick } from "./clock/hourly";
import { prepareOffline } from "./data/offline";
import { requestWakeLock } from "./data/wake-lock";
export function App() {
  const [initial] = useState(loadSettings);
  const [settings, setSettings] = useState(initial.value);
  const [warning, setWarning] = useState(initial.warning);
  const [open, setOpen] = useState(false);
  const [weatherOpen, setWeatherOpen] = useState(false);
  const focusTarget = useRef<string | null>(null);
  const weatherOpener = useRef("weather-region-opener");
  const requestGeneration = useRef(0);
  const refreshDashboard = useRef<() => Promise<void>>(async () => {});
  const [data, setData] = useState<Dashboard>(emptyDashboard);
  const [connection, setConnection] = useState("集約サービスに接続中");
  const [cardNow, setCardNow] = useState(Date.now());
  const [offline, setOffline] = useState("オフライン準備中");
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [wake, setWake] = useState("画面点灯の保持は未設定");
  const [audio, setAudio] = useState<ReturnType<
    typeof createAudioController
  > | null>(null);
  const settingsRef = useRef(settings),
    generation = useRef(0),
    current = useRef(data);
  useEffect(() => {
    settingsRef.current = settings;
    generation.current++;
    if (settings.audioMode === "off") audio?.disable();
    else void audio?.stop();
  }, [settings, audio]);
  useEffect(() => {
    let cancelled = false,
      controller: ReturnType<typeof createAudioController> | null = null;
    void loadManifest().then((manifest) => {
      if (cancelled) return;
      controller = createAudioController(() => settingsRef.current, manifest);
      setAudio(controller);
    });
    return () => {
      cancelled = true;
      controller?.dispose();
    };
  }, []);
  useEffect(() => {
    if (!audio) return;
    let previous: Tick | null = null;
    const visibility = () => {
      generation.current++;
      previous = null;
      if (document.hidden) void audio.stop();
    };
    document.addEventListener("visibilitychange", visibility);
    const timer = setInterval(() => {
      const tick: Tick = {
        wallMs: Date.now(),
        monoMs: performance.now(),
        visible: !document.hidden,
        generation: generation.current,
      };
      const decision = evaluateHour(previous, tick, settingsRef.current);
      previous = tick;
      if (
        decision.reason === "clock_resync" ||
        decision.reason === "resync" ||
        document.hidden ||
        isQuiet(tick.wallMs, settingsRef.current)
      )
        void audio.stop();
      else void audio.announce(decision);
    }, 250);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      void audio.stop();
    };
  }, [audio]);
  useEffect(() => {
    let dead = false,
      busyGeneration: number | null = null,
      hydratedFromNetwork = false;
    let abort: AbortController | null = null;
    async function refresh() {
      const capturedGeneration = requestGeneration.current;
      if (busyGeneration === capturedGeneration || dead) return;
      abort?.abort();
      busyGeneration = capturedGeneration;
      const controller = new AbortController();
      abort = controller;
      const timeout = setTimeout(() => controller.abort(), 10000);
      const active = () =>
        !dead && capturedGeneration === requestGeneration.current;
      try {
        const next = await fetchDashboard(controller.signal);
        if (!active()) return;
        hydratedFromNetwork = true;
        current.current = mergeDashboard(current.current, next);
        setData(current.current);
        setConnection("集約サービス接続済み");
        try {
          await saveDashboard(current.current);
        } catch {
          if (active())
            setWarning("カードを保存できません。通信中の表示は続けます");
        }
      } catch (error) {
        if (active())
          setConnection(
            navigator.onLine
              ? (error as Error).message === "auth"
                ? "集約サービスの認証が必要"
                : "集約サービスに未接続"
              : "オフライン · 保存済み情報を表示",
          );
      } finally {
        clearTimeout(timeout);
        if (busyGeneration === capturedGeneration) busyGeneration = null;
        if (active()) setCardNow(Date.now());
      }
    }
    refreshDashboard.current = refresh;
    const cacheGeneration = requestGeneration.current;
    void loadDashboard()
      .then((cached) => {
        if (
          !dead &&
          cacheGeneration === requestGeneration.current &&
          !hydratedFromNetwork &&
          cached
        ) {
          current.current = cached;
          setData(cached);
        }
      })
      .catch(() => {
        if (!dead && cacheGeneration === requestGeneration.current)
          setWarning("保存済みカードを読み込めません");
      })
      .finally(() => void refresh());
    const resume = () => {
      if (!document.hidden) void refresh();
    };
    const off = () => setConnection("オフライン · 保存済み情報を表示");
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", off);
    const timer = setInterval(() => {
      setCardNow(Date.now());
      void refresh();
    }, 30000);
    return () => {
      dead = true;
      abort?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", off);
    };
  }, []);
  useEffect(() => {
    if (!weatherOpen && focusTarget.current) {
      document.getElementById(focusTarget.current)?.focus();
      focusTarget.current = null;
    }
  }, [open, weatherOpen]);
  const openWeather = (opener: string) => {
    weatherOpener.current = opener;
    setWeatherOpen(true);
  };
  const closeWeather = () => {
    focusTarget.current = weatherOpener.current;
    setWeatherOpen(false);
  };
  const closeSettings = () => {
    focusTarget.current = "general-settings-opener";
    setOpen(false);
  };
  const weatherSaved = (weather: Weather) => {
    const capturedGeneration = ++requestGeneration.current;
    invalidateDashboardCache();
    current.current = { ...current.current, weather };
    setData(current.current);
    setCardNow(Date.now());
    void saveDashboard(current.current).catch(() => {
      if (capturedGeneration === requestGeneration.current)
        setWarning("カードを保存できません。通信中の表示は続けます");
    });
    void refreshDashboard.current();
  };
  useEffect(() => {
    void prepareOffline(setOffline, setWaiting);
  }, []);
  useEffect(() => {
    const closeDetails = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      document
        .querySelectorAll<HTMLDetailsElement>(".card-details[open]")
        .forEach((details) => {
          if (details.contains(document.activeElement))
            details.querySelector<HTMLElement>("summary")?.focus();
          details.open = false;
        });
    };
    document.addEventListener("keydown", closeDetails);
    return () => document.removeEventListener("keydown", closeDetails);
  }, []);
  const activateUpdate = () => {
    if (!waiting) return;
    audio?.disable();
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => location.reload(),
      { once: true },
    );
    waiting.postMessage("ACTIVATE_UPDATE");
  };
  return (
    <main
      className={`dashboard ${open || weatherOpen ? "settings-open" : "overview"}`}
    >
      <header>
        <div className="brand">
          <span className="brand-mark">◷</span> FIRE <span>DASHBOARD</span>
        </div>
        <div className="header-actions">
          <span className="connection">
            <span className="connection-dot" />
            {connection}
          </span>
          <button
            id="general-settings-opener"
            aria-label="設定"
            disabled={weatherOpen}
            onClick={() => (open ? closeSettings() : setOpen(true))}
          >
            設定 <span aria-hidden="true">⚙</span>
          </button>
        </div>
      </header>
      {warning && (
        <div role="alert" className="notice">
          {warning}
        </div>
      )}
      {waiting && (
        <div className="notice">
          新しい表示の準備ができました{" "}
          <button onClick={activateUpdate} disabled={weatherOpen}>
            更新して再読み込み
          </button>
        </div>
      )}
      {weatherOpen ? (
        <WeatherSettings onClose={closeWeather} onSaved={weatherSaved} />
      ) : open ? (
        <Settings
          value={settings}
          onChange={(v) => {
            setSettings(v);
            if (!saveSettings(v))
              setWarning("設定を保存できません。この画面では変更を維持します");
          }}
          onClose={closeSettings}
          onWeatherSettings={() =>
            openWeather("settings-weather-region-opener")
          }
        />
      ) : (
        <>
          <div className="top-grid">
            <Clock settings={settings} />
            <WeatherCard
              value={data.weather}
              onWeatherSettings={() => openWeather("weather-region-opener")}
              timeZone={settings.timeZone}
              now={cardNow}
            />
          </div>
          <div className="bottom-grid provider-layout">
            <section className="usage-grid" aria-label="AI利用状況">
              {(["claude", "codex"] as const).map((provider) => (
                <UsageCard
                  key={provider}
                  value={
                    data.usage.find((u) => u.provider === provider) ??
                    emptyDashboard().usage.find((u) => u.provider === provider)!
                  }
                  timeZone={settings.timeZone}
                  now={cardNow}
                />
              ))}
              <AdditionalUsageCards
                usage={data.usage}
                timeZone={settings.timeZone}
                now={cardNow}
              />
            </section>
            <RssCard
              feeds={data.rss}
              autoRotate={settings.rssAutoRotate}
              timeZone={settings.timeZone}
              now={cardNow}
            />
          </div>
          <div className="control-strip">
            <AudioControls controller={audio} />
            <div className="wake-controls">
              <span>{wake}</span>
              <button
                onClick={async () => {
                  const result = await requestWakeLock(() =>
                    setWake("画面点灯の保持が解除されました"),
                  );
                  setWake(
                    result === "held"
                      ? "画面点灯を保持中"
                      : result === "unsupported"
                        ? "このブラウザーは点灯保持に未対応"
                        : "点灯保持を許可できませんでした",
                  );
                }}
              >
                画面を点灯保持
              </button>
            </div>
          </div>
        </>
      )}
      <footer>
        <span>{offline}</span>
        <span>Fire HD 10 Plus · 前面表示用 · 実機試験前</span>
      </footer>
    </main>
  );
}
