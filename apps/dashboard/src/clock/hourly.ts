import type { AppSettings } from "../../../../packages/contracts/src/index";
export type Tick = {
  wallMs: number;
  monoMs: number;
  visible: boolean;
  generation: number;
};
export type HourDecision = {
  key: string | null;
  hour: number | null;
  reason: string;
  expiresAt?: number;
};
export function localParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ms);
  const p = (type: string) => parts.find((x) => x.type === type)!.value;
  return {
    date: `${p("year")}-${p("month")}-${p("day")}`,
    hour: Number(p("hour")),
    minute: Number(p("minute")),
    second: Number(p("second")),
  };
}
export function isQuiet(ms: number, settings: AppSettings): boolean {
  if (!settings.quiet.enabled) return false;
  const p = localParts(ms, settings.timeZone);
  const minute = p.hour * 60 + p.minute;
  const convert = (v: string) =>
    Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
  const start = convert(settings.quiet.start),
    end = convert(settings.quiet.end);
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}
export function evaluateHour(
  previous: Tick | null,
  current: Tick,
  settings: AppSettings,
): HourDecision {
  const no = (reason: string): HourDecision => ({
    key: null,
    hour: null,
    reason,
  });
  if (!previous) return no("startup");
  if (
    !previous.visible ||
    !current.visible ||
    previous.generation !== current.generation
  )
    return no("resync");
  const wall = current.wallMs - previous.wallMs,
    mono = current.monoMs - previous.monoMs;
  if (wall <= 0 || mono < 0 || mono > 15000 || Math.abs(wall - mono) > 2000)
    return no("clock_resync");
  const p = localParts(current.wallMs, settings.timeZone);
  const milliseconds = ((current.wallMs % 1000) + 1000) % 1000;
  const sinceHour = (p.minute * 60 + p.second) * 1000 + milliseconds;
  if (sinceHour > 10000) return no("outside_window");
  if (wall <= sinceHour) return no("no_boundary");
  if (settings.audioMode === "off") return no("disabled");
  if (isQuiet(current.wallMs, settings)) return no("quiet");
  return {
    key: `${settings.timeZone}|${p.date}|${String(p.hour).padStart(2, "0")}`,
    hour: p.hour,
    reason: "boundary",
    expiresAt: current.wallMs - sinceHour + 10000,
  };
}
