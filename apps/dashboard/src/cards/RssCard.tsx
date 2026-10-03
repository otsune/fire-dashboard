import { useEffect, useRef, useState } from "react";
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
  const card = useRef<HTMLElement>(null);
  const articleTrip = useRef<{
    link: HTMLAnchorElement;
    departed: boolean;
  } | null>(null);
  const returnedLink = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    const clearIntent = () => {
      articleTrip.current = null;
      returnedLink.current = null;
    };
    const leave = () => {
      // A later, unrelated departure must not inherit a previous return exemption.
      returnedLink.current = null;
      if (articleTrip.current?.link.isConnected)
        articleTrip.current.departed = true;
      else articleTrip.current = null;
    };
    const resume = () => {
      if (document.hidden || !articleTrip.current?.departed) return;
      returnedLink.current = articleTrip.current.link.isConnected
        ? articleTrip.current.link
        : null;
      articleTrip.current = null;
    };
    const visibility = () => (document.hidden ? leave() : resume());
    window.addEventListener("blur", leave);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("pointerdown", clearIntent, true);
    document.addEventListener("keydown", clearIntent, true);
    return () => {
      window.removeEventListener("blur", leave);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("pointerdown", clearIntent, true);
      document.removeEventListener("keydown", clearIntent, true);
    };
  }, []);
  const [index, setIndex] = useState(0),
    [paused, setPaused] = useState(false),
    [expanded, setExpanded] = useState(false);
  const items = feeds.flatMap((f) =>
    f.items.map((item) => ({ ...item, feed: f })),
  );
  useEffect(() => {
    if (!autoRotate || paused || expanded || items.length < 2) return;
    const timer = setInterval(() => {
      // Read live DOM focus: removing a focused headline need not emit blur.
      const active = document.activeElement;
      const reading =
        active instanceof Element &&
        card.current?.contains(active) &&
        !!active.closest(".headline-preview, .detail-content");
      if (document.hidden || (reading && active !== returnedLink.current))
        return;
      setIndex((i) => (i + 1) % items.length);
    }, 15000);
    return () => clearInterval(timer);
  }, [autoRotate, paused, expanded, items.length]);
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
      ref={card}
      onClick={(event) => {
        const link =
          event.target instanceof Element
            ? event.target.closest<HTMLAnchorElement>(
                ".headline-preview a[target='_blank']",
              )
            : null;
        if (
          link &&
          !event.defaultPrevented &&
          event.button === 0 &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !event.shiftKey
        ) {
          // Explicit article activation (pointer or keyboard) plus an observed
          // departure is required; ordinary reading focus never grants this.
          articleTrip.current = { link, departed: false };
        }
      }}
      onFocusCapture={(event) => {
        if (event.target !== returnedLink.current) returnedLink.current = null;
        if (event.target !== articleTrip.current?.link)
          articleTrip.current = null;
      }}
      onBlurCapture={(event) => {
        // A null target can be a window departure, not a new reading target.
        if (event.relatedTarget && event.relatedTarget !== event.target) {
          articleTrip.current = null;
          returnedLink.current = null;
        }
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
