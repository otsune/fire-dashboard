import type {
  AppSettings,
  Feed,
} from "../../../../packages/contracts/src/index";
import { deriveStatus } from "../data/status";

export function RssSettings({
  value,
  feeds,
  onChange,
}: {
  value: AppSettings;
  feeds: Feed[];
  onChange: (value: AppSettings) => void;
}) {
  return (
    <>
      <div className="settings-grid">
        <label className="check">
          <input
            type="checkbox"
            checked={value.rssAutoRotate}
            onChange={(event) =>
              onChange({ ...value, rssAutoRotate: event.target.checked })
            }
          />
          RSSを15秒ごとに切り替える
        </label>
      </div>
      <h2 className="settings-subheading">現在のRSS</h2>
      {feeds.length ? (
        <ul className="settings-status-list">
          {feeds.map((feed) => (
            <li key={feed.id}>
              <span>{feed.label}</span>
              <span className="status">
                {deriveStatus(feed, Date.now()).label}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p>RSSは未設定です</p>
      )}
      <p className="settings-help">
        RSSの追加・編集・削除・並べ替えは次の段階で対応します。
      </p>
    </>
  );
}
