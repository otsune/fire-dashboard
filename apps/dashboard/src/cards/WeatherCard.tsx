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
  return (
    <section className="card weather-card">
      <div className="card-heading">
        <span className="eyebrow">WEATHER</span>
        <span className="status">{status.label}</span>
      </div>
      <h2>{value.regionLabel ?? "天気予報"}</h2>
      {value.regionId === null ? (
        <div className="empty-state">
          <span className="weather-symbol" aria-hidden="true">
            ☀
          </span>
          <h3>地域未設定</h3>
          <p>
            予報地域と気温の代表地点を
            <br />
            設定すると表示されます
          </p>
        </div>
      ) : (
        <>
          <p className="small">
            気温地点：{value.temperatureStationLabel ?? "未設定"}
          </p>
          <div className="forecast-list">
            {periods.length ? (
              periods.map((p) => (
                <div key={p.startsAt + p.endsAt} className="forecast">
                  <span>
                    {formatTime(p.startsAt, timeZone)}〜
                    {formatTime(p.endsAt, timeZone)}
                  </span>
                  <strong>{p.summary ?? "予報未取得"}</strong>
                  <span>
                    予報気温 {p.temperatureMinC ?? "—"}〜
                    {p.temperatureMaxC ?? "—"} °C · 降水{" "}
                    {p.precipitationProbabilityPct ?? "—"}%
                  </span>
                </div>
              ))
            ) : (
              <p>有効な予報を待っています</p>
            )}
          </div>
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
    </section>
  );
}
