import type { Usage } from "../../../../packages/contracts/src/index";
import { deriveStatus, formatTime } from "../data/status";
export function UsageCard({
  value,
  timeZone,
  now,
}: {
  value: Usage;
  timeZone: string;
  now: number;
}) {
  const status = deriveStatus(value, now);
  return (
    <section className="card usage-card">
      <div className="card-heading">
        <div className={`provider-icon ${value.provider}`} aria-hidden="true">
          {value.provider === "claude" ? "✳" : "›_"}
        </div>
        <span className="status">{status.label}</span>
      </div>
      <h2>
        {value.provider === "claude" ? "Claude" : "Codex"}
        <span className="provider-sub">利用状況</span>
      </h2>
      {value.buckets.length ? (
        value.buckets.map((b) => (
          <div key={b.id} className="usage-bucket">
            <h3>{b.label}</h3>
            {b.windows.map((w) => (
              <div key={w.id} className="usage-window">
                <div className="window-label">
                  <span>
                    {w.label}
                    {w.windowMinutes !== null ? ` · ${w.windowMinutes}分` : ""}
                  </span>
                  <strong>
                    {w.usedPercent === null ? "未取得" : `${w.usedPercent}%`}
                  </strong>
                </div>
                {w.usedPercent !== null && (
                  <progress
                    value={w.usedPercent}
                    max="100"
                    aria-label={`${b.label} ${w.label} 使用率`}
                  />
                )}
                <p className="small">
                  リセット予定 {formatTime(w.resetsAt, timeZone)}
                </p>
              </div>
            ))}
          </div>
        ))
      ) : (
        <div className="usage-empty">
          <span className="empty-number">
            —<span>%</span>
          </span>
          <p>取得元PCに未接続</p>
          <div className="empty-track" />
          <p className="small">読み取り専用の収集処理を接続してください</p>
        </div>
      )}
      <div className="card-meta">
        <span>最終受信 {formatTime(value.receivedAt, timeZone)}</span>
        {value.sourceAlias && <span>{value.sourceAlias}</span>}
      </div>
    </section>
  );
}
