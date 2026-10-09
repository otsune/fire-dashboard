import type {
  AppSettings,
  Usage,
  UsageDisplayProvider,
} from "../../../../packages/contracts/src/index";
import { deriveStatus } from "../data/status";
import { isUsageConfigured } from "./visibility";

const providers: { id: UsageDisplayProvider; label: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "antigravity", label: "Google AI（Antigravity）" },
  { id: "opencode_go", label: "OpenCode Go" },
  { id: "hermes_nous", label: "Hermes / Nous" },
  { id: "grok", label: "Grok" },
];

export function UsageSettings({
  value,
  usage,
  onChange,
}: {
  value: AppSettings;
  usage: Usage[];
  onChange: (value: AppSettings) => void;
}) {
  return (
    <>
      <p className="settings-help">
        表示の切り替えはこのブラウザーだけに適用されます。非表示でもデータの収集は続きます。
      </p>
      <ul className="settings-status-list usage-settings-list">
        {providers.map(({ id, label }) => {
          const data = usage.find((item) => item.provider === id);
          const status =
            id === "grok"
              ? "未接続・接続後に表示"
              : isUsageConfigured(data) && data
                ? deriveStatus(data, Date.now()).label
                : "未接続";
          return (
            <li key={id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={value.usageVisibility[id]}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      usageVisibility: {
                        ...value.usageVisibility,
                        [id]: event.target.checked,
                      },
                    })
                  }
                />
                {label}を表示する
              </label>
              <span className="status">{status}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
