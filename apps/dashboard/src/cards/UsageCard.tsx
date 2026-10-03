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
function windowLabel(
  window: Usage["buckets"][number]["windows"][number],
): string {
  if (window.windowMinutes === null) return window.label;
  const days = Math.floor(window.windowMinutes / 1440);
  const hours = Math.floor((window.windowMinutes % 1440) / 60);
  const minutes = window.windowMinutes % 60;
  if (days && !hours && !minutes) return `${days}日間`;
  return [
    days ? `${days}日` : "",
    hours ? `${hours}時間` : "",
    minutes ? `${minutes}分` : "",
  ].join("");
}

function showBucketLabel(value: Usage, label: string): boolean {
  if (value.buckets.length > 1) return true;
  const normalized = label.trim().toLowerCase();
  return (
    normalized !== "利用上限" &&
    normalized !== providerPresentation[value.provider].name.toLowerCase()
  );
}

function relativeReset(
  iso: string | null,
  now: number,
  renewal = false,
): string {
  const event = renewal ? "更新" : "リセット";
  if (!iso) return `${event}時刻不明`;
  const remaining = Date.parse(iso) - now;
  if (remaining <= 0) return renewal ? "更新待ち" : "リセット後・更新待ち";
  const minutes = Math.ceil(remaining / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const duration = days
    ? `${days}日${hours ? `${hours}時間` : ""}`
    : hours
      ? `${hours}時間${rest ? `${rest}分` : ""}`
      : `${rest}分`;
  return `${event}まで ${duration}`;
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
  const windows = value.buckets.flatMap((bucket) =>
    bucket.windows.map((window) => ({ bucket, window })),
  );
  // A USD balance is authoritative for Nous, including an explicitly zero balance.
  const showBalance =
    !!balance && (value.provider === "hermes_nous" || !windows.length);
  return (
    <section
      className="card usage-card"
      data-provider={value.provider}
      data-stale={status.stale}
    >
      <div className="card-heading">
        <h2>
          <span
            className={`provider-icon ${value.provider}`}
            aria-hidden="true"
          >
            {provider.icon}
          </span>
          {provider.name}
          <span className="provider-sub">利用状況</span>
        </h2>
        <span className="status">{status.label}</span>
      </div>
      <div className="usage-overview">
        {showBalance ? (
          <div className="usage-total">
            <span className="usage-total-label">USD 合計残高</span>
            <strong className="usage-value">
              {dollars(balance.totalRemaining)}
            </strong>
            <p className="usage-reset">
              {relativeReset(balance.renewsAt, now, true)}
            </p>
          </div>
        ) : windows.length ? (
          windows.slice(0, 2).map(({ bucket, window }) => (
            <div
              key={`${bucket.id}:${window.id}`}
              className="usage-primary-window"
            >
              <div className="window-label">
                <span title={`${bucket.label} · ${window.label}`}>
                  {showBucketLabel(value, bucket.label)
                    ? `${bucket.label} · `
                    : ""}
                  {windowLabel(window)}
                </span>
                <strong className="usage-value">
                  {window.usedPercent === null
                    ? "未取得"
                    : `${window.usedPercent}%`}
                </strong>
              </div>
              {window.usedPercent !== null && (
                <progress
                  value={window.usedPercent}
                  max="100"
                  aria-label={`${bucket.label} ${window.label} 使用率`}
                />
              )}
              <p className="usage-reset">
                {relativeReset(window.resetsAt, now)}
              </p>
            </div>
          ))
        ) : (
          <div className="usage-empty">
            <span className="empty-number usage-value">
              —<span>{value.provider === "hermes_nous" ? "USD" : "%"}</span>
            </span>
            <p>{emptyMessage(value)}</p>
          </div>
        )}
      </div>
      <details className="card-details">
        <summary aria-label={`${provider.name} 利用状況の詳細`}>詳細</summary>
        <div className="detail-content">
          <button
            type="button"
            className="detail-close"
            onClick={(event) => {
              const details = event.currentTarget.closest("details");
              if (details) {
                details.open = false;
                details.querySelector("summary")?.focus();
              }
            }}
          >
            詳細を閉じる
          </button>
          <h3>利用状況の内訳</h3>
          {value.buckets.map((bucket) => (
            <div key={bucket.id} className="usage-bucket">
              <h3>{bucket.label}</h3>
              {bucket.windows.map((window) => (
                <div key={window.id} className="usage-window">
                  <strong>{window.label}</strong>
                  <p>
                    使用率{" "}
                    {window.usedPercent === null
                      ? "未取得"
                      : `${window.usedPercent}%`}
                  </p>
                  {window.windowMinutes !== null && (
                    <p className="small">集計期間 {window.windowMinutes}分</p>
                  )}
                  <p className="small">
                    リセット予定 {formatTime(window.resetsAt, timeZone)}
                  </p>
                </div>
              ))}
            </div>
          ))}
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
          {!windows.length && !balance && (
            <p className="small">読み取り専用の収集処理を接続してください</p>
          )}
          <div className="card-meta">
            {value.sourceAlias && <span>{value.sourceAlias}</span>}
            <span>最終受信 {formatTime(value.receivedAt, timeZone)}</span>
            <span>
              元データ観測 {formatTime(value.sourceObservedAt, timeZone)}
            </span>
            <span>収集日時 {formatTime(value.capturedAt, timeZone)}</span>
            <span>最終成功 {formatTime(value.lastSuccessAt, timeZone)}</span>
          </div>
        </div>
      </details>
    </section>
  );
}
