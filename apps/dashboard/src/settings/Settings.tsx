import { useState } from "react";
import {
  readSettings,
  type AppSettings,
} from "../../../../packages/contracts/src/index";
export function Settings({
  value,
  onChange,
  onClose,
  onWeatherSettings,
}: {
  value: AppSettings;
  onChange: (value: AppSettings) => void;
  onClose: () => void;
  onWeatherSettings?: () => void;
}) {
  const [warning, setWarning] = useState("");
  const update = (patch: Partial<AppSettings>) => {
    const r = readSettings({ ...value, ...patch });
    setWarning(r.warnings.join("。"));
    if (!r.warnings.length) onChange(r.value);
  };
  return (
    <section className="settings-panel" aria-label="表示と音の設定">
      <div className="section-heading">
        <h1>表示と音の設定</h1>
        <button onClick={onClose}>時計に戻る</button>
      </div>
      {warning && <p role="alert">{warning}</p>}
      <div className="settings-grid">
        <label>
          タイムゾーン
          <input
            defaultValue={value.timeZone}
            onBlur={(e) => update({ timeZone: e.target.value })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={value.hour12}
            onChange={(e) => update({ hour12: e.target.checked })}
          />
          12時間表記
        </label>
        <label>
          時報の種類
          <select
            value={value.audioMode}
            onChange={(e) =>
              update({ audioMode: e.target.value as AppSettings["audioMode"] })
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
            onChange={(e) => update({ volume: Number(e.target.value) / 100 })}
          />
          <span>{Math.round(value.volume * 100)}% · 端末音量は別設定です</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={value.quiet.enabled}
            onChange={(e) =>
              update({ quiet: { ...value.quiet, enabled: e.target.checked } })
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
              onChange={(e) =>
                update({ quiet: { ...value.quiet, start: e.target.value } })
              }
            />
          </label>
          <label>
            静音終了
            <input
              type="time"
              value={value.quiet.end}
              onChange={(e) =>
                update({ quiet: { ...value.quiet, end: e.target.value } })
              }
            />
          </label>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={value.rssAutoRotate}
            onChange={(e) => update({ rssAutoRotate: e.target.checked })}
          />
          RSSを15秒ごとに切り替える
        </label>
      </div>
      <div className="settings-note">
        <h2>データの接続</h2>
        {onWeatherSettings && (
          <button
            id="settings-weather-region-opener"
            onClick={onWeatherSettings}
          >
            天気の地域を設定
          </button>
        )}
        <p>
          天気の地域・代表地点はこの画面から確認・変更できます。変更には管理者権限が必要です。RSSは集約サーバーで設定します。Claude・Codexは利用元PCの読み取り専用収集処理から接続します。
        </p>
        <p>
          4音チャイムを同梱しています。音声は「12時間表記」に連動し、12時間は午前・午後付き、24時間は午前・午後なしです。各形式に24本の私用音源が必要です。未設定の形式は再生できません。前面表示・最初のタップが必要です。
        </p>
        <a href="/licenses/DSEG-LICENSE.txt" target="_blank" rel="noreferrer">
          DSEGのライセンス
        </a>
      </div>
    </section>
  );
}
