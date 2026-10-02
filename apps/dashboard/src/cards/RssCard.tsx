import { useEffect, useState } from "react";
import type { Feed } from "../../../../packages/contracts/src/index";
import { deriveStatus, formatTime } from "../data/status";
export function RssCard({
  feeds,
  autoRotate,
  timeZone,
  now,
}: {
  feeds: Feed[];
  autoRotate: boolean;
  timeZone: string;
  now: number;
}) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const items = feeds.flatMap((f) =>
    f.items.map((item) => ({ ...item, feed: f })),
  );
  useEffect(() => {
    if (!autoRotate || paused || items.length < 4) return;
    const timer = setInterval(
      () => setIndex((i) => (i + 3) % items.length),
      15000,
    );
    return () => clearInterval(timer);
  }, [autoRotate, paused, items.length]);
  const visible = items.length
    ? Array.from(
        { length: Math.min(3, items.length) },
        (_, i) => items[(index + i) % items.length],
      )
    : [];
  return (
    <section className="card rss-card">
      <div className="card-heading">
        <span className="eyebrow">READING LIST</span>
        {items.length > 3 && (
          <button className="small-button" onClick={() => setPaused((v) => !v)}>
            {paused ? "切替を再開" : "切替を停止"}
          </button>
        )}
        <span className="status">
          {feeds.length ? `${items.length}件` : "未設定"}
        </span>
      </div>
      <h2>
        ニュース <span className="provider-sub">RSS</span>
      </h2>
      {feeds.length === 0 ? (
        <div className="rss-empty">
          <span aria-hidden="true">☷</span>
          <div>
            <h3>フィード未登録</h3>
            <p>
              気になる情報を、ここに。
              <br />
              登録したRSSの見出しが表示されます
            </p>
          </div>
        </div>
      ) : (
        <div className="headlines">
          {visible.map((v) => (
            <article key={v.feed.id + v.id}>
              <div className="headline-meta">
                {v.sourceLabel} ·{" "}
                {v.publishedAt
                  ? formatTime(v.publishedAt, timeZone)
                  : "日時不明"}
              </div>
              {v.url ? (
                <a href={v.url} target="_blank" rel="noopener noreferrer">
                  {v.title}
                </a>
              ) : (
                <span>{v.title}</span>
              )}
            </article>
          ))}
          {!items.length && <p>見出しはまだありません</p>}
        </div>
      )}
      <div className="card-meta">
        {feeds.length ? (
          feeds.map((f) => (
            <span key={f.id}>
              {f.label} · {deriveStatus(f, now).label} · 取得{" "}
              {formatTime(f.lastSuccessAt, timeZone)}
            </span>
          ))
        ) : (
          <span>15分ごとに更新 · 記事は別画面で開きます</span>
        )}
      </div>
    </section>
  );
}
