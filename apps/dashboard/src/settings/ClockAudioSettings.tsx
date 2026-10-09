import { useEffect, useState } from "react";
import {
  readSettings,
  type AppSettings,
} from "../../../../packages/contracts/src/index";

function DsegLicense() {
  const [text, setText] = useState("");
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setText("");
    setError(false);
    void fetch("/licenses/DSEG-LICENSE.txt", {
      mode: "same-origin",
      redirect: "error",
      headers: { Accept: "text/plain" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (
          !response.ok ||
          !response.headers
            .get("Content-Type")
            ?.toLowerCase()
            .startsWith("text/plain")
        )
          throw new Error("license unavailable");
        const next = await response.text();
        if (!next.trim()) throw new Error("empty license");
        if (active) setText(next);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [retry]);
  return (
    <div className="settings-license">
      <h2>DSEGのライセンス</h2>
      {error ? (
        <>
          <p role="alert">
            ライセンスを取得できません。接続を確認して再読み込みしてください。
          </p>
          <button onClick={() => setRetry((n) => n + 1)}>
            ライセンスを再読み込み
          </button>
        </>
      ) : text ? (
        <pre>{text}</pre>
      ) : (
        <p role="status">ライセンスを読み込み中…</p>
      )}
    </div>
  );
}

export function ClockAudioSettings({
  value,
  onChange,
}: {
  value: AppSettings;
  onChange: (value: AppSettings) => void;
}) {
  const [warning, setWarning] = useState("");
  const update = (patch: Partial<AppSettings>) => {
    const result = readSettings({ ...value, ...patch });
    setWarning(result.warnings.join("。"));
    if (!result.warnings.length) onChange(result.value);
  };
  return (
    <>
      {warning && <p role="alert">{warning}</p>}
      <div className="settings-grid">
        <label>
          タイムゾーン
          <input
            defaultValue={value.timeZone}
            onBlur={(event) => update({ timeZone: event.target.value })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={value.hour12}
            onChange={(event) => update({ hour12: event.target.checked })}
          />
          12時間表記
        </label>
        <label>
          時報の種類
          <select
            value={value.audioMode}
            onChange={(event) =>
              update({
                audioMode: event.target.value as AppSettings["audioMode"],
              })
            }
          >
            <option value="voice">音声のみ</option>
            <option value="chime">チャイムのみ</option>
            <option value="both">チャイムと音声</option>
            <option value="off">無音</option>
          </select>
        </label>
        <label>
          アプリ内音量
          <input
            aria-label="アプリ内音量"
            type="range"
            min="0"
            max="100"
            value={Math.round(value.volume * 100)}
            onChange={(event) =>
              update({ volume: Number(event.target.value) / 100 })
            }
          />
          <span>{Math.round(value.volume * 100)}% · 端末音量は別設定です</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={value.quiet.enabled}
            onChange={(event) =>
              update({
                quiet: { ...value.quiet, enabled: event.target.checked },
              })
            }
          />
          静音時間を使う
        </label>
        <div className="time-range">
          <label>
            静音開始
            <input
              type="time"
              value={value.quiet.start}
              onChange={(event) =>
                update({ quiet: { ...value.quiet, start: event.target.value } })
              }
            />
          </label>
          <label>
            静音終了
            <input
              type="time"
              value={value.quiet.end}
              onChange={(event) =>
                update({ quiet: { ...value.quiet, end: event.target.value } })
              }
            />
          </label>
        </div>
      </div>
      <div className="settings-note">
        <p>
          4音チャイムを同梱しています。音声は「12時間表記」に連動し、12時間は午前・午後付き、24時間は午前・午後なしです。両形式のGemini音声48本を同梱しています。独自のmanifestで欠けている形式は再生できません。前面表示・最初のタップが必要です。
        </p>
        <DsegLicense />
      </div>
    </>
  );
}
