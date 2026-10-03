import type { Weather } from "../../../../packages/contracts/src/index";
import { deriveStatus, formatTime } from "../data/status";
export function WeatherCard({
  value,
  timeZone,
  now,
}: {
  value: Weather;
  timeZone: string;
  now: number;
}) {
  const status = deriveStatus(value, now);
  const periods = value.periods
    .filter((p) => Date.parse(p.endsAt) > now)
    .slice(0, 4);
  const forecast = (p: Weather["periods"][number]) => (
    <div key={p.startsAt + p.endsAt} className="forecast">
      <span>
        {formatTime(p.startsAt, timeZone)}〜{formatTime(p.endsAt, timeZone)}
      </span>
      <strong>{p.summary ?? "予報未取得"}</strong>
      <span>
        予報気温 {p.temperatureMinC ?? "—"}〜{p.temperatureMaxC ?? "—"} °C ·
        降水 {p.precipitationProbabilityPct ?? "—"}%
      </span>
    </div>
  );
  return (
    <section
      className={`card weather-card ${value.regionId === null ? "is-unconfigured" : ""}`}
    >
      <div className="card-heading">
        <h2>{value.regionLabel ?? "天気予報"}</h2>
        <span className="status">{status.label}</span>
      </div>
      {value.regionId === null ? (
        <p className="weather-placeholder">地域未設定</p>
      ) : periods.length ? (
        forecast(periods[0])
      ) : (
        <p>有効な予報を待っています</p>
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
              集約サービスの設定ファイルで weather
              の予報地域と気温の代表地点を指定してください。
              <a
                href="https://github.com/otsune/fire-dashboard/blob/main/docs/deployment.md"
                target="_blank"
                rel="noreferrer"
              >
                設定手順
              </a>
            </p>
          ) : (
            <>
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
    </section>
  );
}
