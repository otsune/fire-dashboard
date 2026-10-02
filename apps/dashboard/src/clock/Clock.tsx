import { useEffect, useState } from "react";
import type { AppSettings } from "../../../../packages/contracts/src/index";
const wallNow = () => Date.now();
export function Clock({
  settings,
  now = wallNow,
}: {
  settings: AppSettings;
  now?: () => number;
}) {
  const [time, setTime] = useState(now);
  useEffect(() => {
    const tick = () => setTime(now());
    const id = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [now]);
  const p = new Intl.DateTimeFormat("ja-JP", {
    timeZone: settings.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: settings.hour12 ? "h12" : "h23",
  }).formatToParts(time);
  const part = (name: string) => p.find((v) => v.type === name)?.value || "";
  const date = new Intl.DateTimeFormat("ja-JP", {
    timeZone: settings.timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(time);
  return (
    <section className="clock-panel" aria-label="時計">
      <div className="eyebrow">
        <span className="live-dot" />
        LOCAL TIME{" "}
        <span className="zone">{settings.timeZone.replaceAll("_", " ")}</span>
      </div>
      <div
        className="clock-face"
        role="timer"
        aria-live="off"
        aria-label={`${part("dayPeriod")}${part("hour")}時${part("minute")}分${part("second")}秒 ${settings.timeZone}`}
      >
        <span className="digits" data-testid="clock-time" aria-hidden="true">
          <span className="clock-hours">{part("hour")}</span>
          <span className="clock-separator">:</span>
          <span className="clock-minutes">{part("minute")}</span>
        </span>
      </div>
      <div className="clock-details">
        <span className="dayperiod" aria-hidden="true">
          {part("dayPeriod")}
        </span>
        <span
          className="seconds"
          data-testid="clock-seconds"
          aria-hidden="true"
        >
          {part("second")}
        </span>
        <span className="clock-date">{date}</span>
      </div>
      <div className="clock-caption">今日も、自分のペースで。</div>
    </section>
  );
}
