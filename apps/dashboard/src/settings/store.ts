import {
  readSettings,
  parseSettings,
  type AppSettings,
} from "../../../../packages/contracts/src/index";
const key = "fire-dashboard-settings-v1";
export function loadSettings(storage?: Pick<Storage, "getItem">): {
  value: AppSettings;
  warning: string | null;
} {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(key);
    const r = readSettings(raw ? JSON.parse(raw) : {});
    return { value: r.value, warning: r.warnings.join("。") || null };
  } catch {
    return {
      value: parseSettings({}),
      warning: "設定を読み込めませんでした。初期値で時計を続けます",
    };
  }
}
export function saveSettings(
  value: AppSettings,
  storage?: Pick<Storage, "setItem">,
): boolean {
  try {
    (storage ?? globalThis.localStorage).setItem(
      key,
      JSON.stringify(parseSettings(value)),
    );
    return true;
  } catch {
    return false;
  }
}
