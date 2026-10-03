import { useEffect, useState, useRef } from "react";
import type { AppSettings } from "../../../../packages/contracts/src/index";
import { clockDigitSize } from "./fit";
const wallNow = () => Date.now();
export function Clock({
  settings,
  now = wallNow,
}: {
  settings: AppSettings;
  now?: () => number;
}) {
  const [time, setTime] = useState(now);
  const face = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = face.current;
    if (!node) return;
    let disposed = false;
    const measure = () => {
      if (
        disposed ||
        !window.matchMedia?.("(orientation: landscape) and (min-width: 700px)")
          .matches
      )
        return;
      const seconds = node.querySelector<HTMLElement>(".seconds");
      const period = node.querySelector<HTMLElement>(".dayperiod");
      const reserved =
        (seconds?.offsetWidth ?? 0) +
        (period?.offsetWidth ?? 0) +
        (period?.textContent ? 20 : 10);
      const size = clockDigitSize(
        node.clientWidth,
        node.clientHeight,
        reserved,
      );
      if (size > 0) node.style.setProperty("--clock-digit-size", `${size}px`);
    };
    // ResizeObserver tracks card-content changes; old WebViews retain resize + CSS fallbacks.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener("resize", measure);
    void document.fonts?.ready.then(measure);
    measure();
    return () => {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [settings.hour12]);
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
      <div className="clock-face" ref={face}>
        <span className="dayperiod">{part("dayPeriod")}</span>
        <span className="digits" data-testid="clock-time">
          <span className="clock-hours">{part("hour")}</span>
          <span className="clock-separator">:</span>
          <span className="clock-minutes">{part("minute")}</span>
        </span>
        <span className="seconds" data-testid="clock-seconds">
          {part("second")}
        </span>
      </div>
      <div className="clock-date">{date}</div>
    </section>
  );
}
