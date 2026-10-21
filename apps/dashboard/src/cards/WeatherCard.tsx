import type { Weather } from "../../../../packages/contracts/src/index";
import { deriveStatus, formatTime } from "../data/status";
import { forecastRegionLabel } from "../data/prefectures";

type WeatherKind = "clear" | "cloud" | "rain" | "snow" | "unknown";

function weatherKind(period: Weather["periods"][number]): WeatherKind {
  const code = period.weatherCode?.trim() ?? "";
  if (code.startsWith("1")) return "clear";
  if (code.startsWith("2")) return "cloud";
  if (code.startsWith("3")) return "rain";
  if (code.startsWith("4")) return "snow";

  const summary = period.summary?.trim() ?? "";
  if (/^雪/.test(summary)) return "snow";
  if (/^雨/.test(summary)) return "rain";
  if (/^(曇り|くもり)/.test(summary)) return "cloud";
  if (/^晴れ/.test(summary)) return "clear";
  if (summary.includes("雪")) return "snow";
  if (summary.includes("雨")) return "rain";
  if (summary.includes("曇") || summary.includes("くもり")) return "cloud";
  return "unknown";
}

function isNight(instant: string, timeZone: string): boolean {
  try {
    const hour = Number(
      new Intl.DateTimeFormat("en", {
        timeZone,
        hour: "numeric",
        hourCycle: "h23",
      }).format(new Date(instant)),
    );
    return hour >= 18 || hour < 6;
  } catch {
    return false;
  }
}

type CompoundWeatherSymbol = {
  main: string;
  secondary: string;
};

function compoundWeatherSymbol(
  summary: string,
): CompoundWeatherSymbol | undefined {
  const normalized = summary.replace(/\s+/g, "");
  if (/^(?:曇り|くもり).*晴れ/.test(normalized))
    return { main: "☁️", secondary: "☀️" };
  if (/^晴れ.*(?:曇り|くもり)/.test(normalized))
    return { main: "☀️", secondary: "☁️" };
  return undefined;
}

function weatherSymbol(
  period: Weather["periods"][number],
  timeZone: string,
): {
  glyph: string;
  label: string;
  compound?: CompoundWeatherSymbol;
} {
  const summary = period.summary?.trim() ?? "";
  const compound = compoundWeatherSymbol(summary);
  if (compound) {
    return {
      glyph: `${compound.main} / ${compound.secondary}`,
      label: compound.main === "☁️" ? "曇りから晴れ" : "晴れから曇り",
      compound,
    };
  }

  switch (weatherKind(period)) {
    case "snow":
      return { glyph: "❄️", label: "雪" };
    case "unknown":
      return { glyph: "—", label: "予報未取得" };
    case "rain":
      return { glyph: "☂️", label: "雨" };
    case "cloud":
      return { glyph: "☁️", label: "曇り" };
    case "clear":
      return isNight(period.startsAt, timeZone)
        ? { glyph: "✨️", label: "夜の晴れ" }
        : { glyph: "☀️", label: "晴れ" };
  }
}

export function WeatherCard({
  value,
  timeZone,
  now,
  onWeatherSettings,
}: {
  value: Weather;
  timeZone: string;
  now: number;
  onWeatherSettings?: () => void;
}) {
  const status = deriveStatus(value, now);
  const periods = value.periods
    .filter((p) => Date.parse(p.endsAt) > now)
    .slice(0, 4);
  const forecast = (p: Weather["periods"][number]) => {
    const symbol = weatherSymbol(p, timeZone);
    return (
      <div
        key={p.startsAt + p.endsAt}
        className={`forecast${symbol.compound ? " forecast--compound" : ""}`}
      >
        <span className="forecast-time">
          {formatTime(p.startsAt, timeZone)}〜{formatTime(p.endsAt, timeZone)}
        </span>
        <span
          className={`weather-symbol${symbol.compound ? " weather-symbol--compound" : ""}`}
          role="img"
          aria-label={symbol.label}
        >
          {symbol.compound ? (
            <>
              <span className="weather-symbol-main">
                {symbol.compound.main}
              </span>
              <span className="weather-symbol-separator"> / </span>
              <span className="weather-symbol-secondary">
                {symbol.compound.secondary}
              </span>
            </>
          ) : (
            symbol.glyph
          )}
        </span>
        <strong className="forecast-summary">
          {p.summary ?? "予報未取得"}
        </strong>
        <span className="forecast-temperature">
          予報気温{" "}
          <strong>
            {p.temperatureMinC ?? "—"}〜{p.temperatureMaxC ?? "—"}
          </strong>{" "}
          °C
        </span>{" "}
        <span className="forecast-precipitation">
          · 降水 {p.precipitationProbabilityPct ?? "—"}%
        </span>
      </div>
    );
  };
  return (
    <section
      className={`card weather-card ${value.regionId === null ? "is-unconfigured" : ""}`}
    >
      <div className="card-heading">
        <h2>{forecastRegionLabel(value.regionId, value.regionLabel)}</h2>
        <span className="status">{status.label}</span>
      </div>
      {value.regionId === null ? (
        <p className="weather-placeholder">地域未設定</p>
      ) : periods.length ? (
        forecast(periods[0])
      ) : (
        <p>有効な予報を待っています</p>
      )}
      <div className="weather-actions">
        {onWeatherSettings && (
          <button
            id="weather-region-opener"
            className="small-button weather-region-button"
            onClick={onWeatherSettings}
          >
            天気の地域を設定
          </button>
        )}
        <details className="card-details">
          <summary>
            {value.regionId === null ? "地域の設定方法" : "予報の詳細"}
          </summary>
          <div className="detail-content">
            <button
              onClick={(event) => {
                const details = event.currentTarget.closest("details")!;
                details.open = false;
                details.querySelector("summary")?.focus();
              }}
            >
              詳細を閉じる
            </button>
            {value.regionId === null ? (
              <p>
                「天気の地域を設定」から予報地方と気温の代表地点を選択できます。変更には管理者権限が必要です。
              </p>
            ) : (
              <>
                <p className="small">
                  予報地方：{value.regionLabel ?? "未設定"}
                </p>
                <p className="small">
                  気温地点：{value.temperatureStationLabel ?? "未設定"}
                </p>
                {periods.map(forecast)}
              </>
            )}
            <div className="card-meta">
              <span>発表 {formatTime(value.issuedAt, timeZone)}</span>
              <a
                href="https://www.jma.go.jp/bosai/forecast/"
                target="_blank"
                rel="noreferrer"
              >
                気象庁
              </a>
            </div>
            <p className="attribution">気象庁の情報を加工して表示</p>
          </div>
        </details>
      </div>
    </section>
  );
}
