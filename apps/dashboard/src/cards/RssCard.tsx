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
  const [focused, setFocused] = useState(false);
  const [index, setIndex] = useState(0),
    [paused, setPaused] = useState(false),
    [expanded, setExpanded] = useState(false);
  const items = feeds.flatMap((f) =>
    f.items.map((item) => ({ ...item, feed: f })),
  );
  useEffect(() => {
    if (!autoRotate || paused || expanded || focused || items.length < 2)
      return;
    const timer = setInterval(
      () => setIndex((i) => (i + 1) % items.length),
      15000,
    );
    return () => clearInterval(timer);
  }, [autoRotate, paused, expanded, focused, items.length]);
  const headline = (v: (typeof items)[number], detail = false) => (
    <article key={v.feed.id + v.id}>
      {detail && (
        <div className="headline-meta">
          {v.sourceLabel} ·{" "}
          {v.publishedAt ? formatTime(v.publishedAt, timeZone) : "日時不明"}
        </div>
      )}
      {v.url ? (
        <a href={v.url} target="_blank" rel="noopener noreferrer">
          {v.title}
        </a>
      ) : (
        <span>{v.title}</span>
      )}
    </article>
  );
  const current = items.length ? items[index % items.length] : null;
  const problem = feeds.find((f) => deriveStatus(f, now).label !== "更新済み");
  return (
    <section
      className="card rss-card"
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      <h2>
        ニュース <span className="provider-sub">RSS</span>
      </h2>
      <div className="headline-preview">
        {current ? (
          headline(current)
        ) : (
          <p>{feeds.length ? "見出しはまだありません" : "フィード未登録"}</p>
        )}
      </div>
      {problem && (
        <span className="status">{deriveStatus(problem, now).label}</span>
      )}
      {items.length > 1 && autoRotate && (
        <button className="small-button" onClick={() => setPaused((v) => !v)}>
          {paused ? "切替を再開" : "切替を停止"}
        </button>
      )}
      <details
        className="card-details"
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>
          {feeds.length ? "すべての見出し" : "フィードの設定方法"}
        </summary>
        <div className="detail-content headlines">
          <button
            onClick={(event) => {
              const details = event.currentTarget.closest("details")!;
              details.open = false;
              details.querySelector("summary")?.focus();
            }}
          >
            詳細を閉じる
          </button>
          {feeds.length ? (
            items.map((v) => headline(v, true))
          ) : (
            <p>
              集約サービスの設定ファイルで RSS のURLを登録してください。
              <a
                href="https://github.com/otsune/fire-dashboard/blob/main/docs/deployment.md"
                target="_blank"
                rel="noreferrer"
              >
                設定手順
              </a>
            </p>
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
        </div>
      </details>
    </section>
  );
}
