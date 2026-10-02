import type { Usage } from "../../../../packages/contracts/src/index";
import { deriveStatus, formatTime } from "../data/status";
import { providerPresentation } from "./providers";
import "./usage.css";
function emptyMessage(value: Usage): string {
  if (value.status === "unconfigured") return "収集処理が未設定です";
  if (value.status === "unsupported") return "この取得元は利用状況に未対応です";
  if (value.errorCode === "auth") return "取得元の認証を確認してください";
  if (value.status === "error") return "利用状況の取得に失敗しました";
  return "利用状況をまだ取得できていません";
}
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
function dollars(value: number | null): string {
  return value === null ? "未取得" : usd.format(value);
}
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
  const provider = providerPresentation[value.provider];
  const balance = value.balance;
  return (
    <section className="card usage-card">
      <div className="card-heading">
        <div className={`provider-icon ${value.provider}`} aria-hidden="true">
          {provider.icon}
        </div>
        <span className="status">{status.label}</span>
      </div>
      <h2>
        {provider.name}
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
      ) : !balance ? (
        <div className="usage-empty">
          <span className="empty-number">
            —<span>{value.provider === "hermes_nous" ? "USD" : "%"}</span>
          </span>
          <p>{emptyMessage(value)}</p>
          <div className="empty-track" />
          <p className="small">読み取り専用の収集処理を接続してください</p>
        </div>
      ) : null}
      {balance && (
        <div className="usage-balance">
          <h3>残高（USD）</h3>
          <dl>
            {(
              [
                ["プラン残高", balance.subscriptionRemaining],
                ["追加購入残高", balance.purchasedRemaining],
                ["合計残高", balance.totalRemaining],
                ["月額枠", balance.monthlyAllowance],
              ] as const
            ).map(([label, amount]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{dollars(amount)}</dd>
              </div>
            ))}
          </dl>
          <p className="small">
            更新予定 {formatTime(balance.renewsAt, timeZone)}
          </p>
          {!value.buckets.length && (
            <p className="small">使用率は未取得・算出対象外です</p>
          )}
        </div>
      )}
      <div className="card-meta">
        <span>最終受信 {formatTime(value.receivedAt, timeZone)}</span>
        {value.sourceAlias && <span>{value.sourceAlias}</span>}
      </div>
    </section>
  );
}
