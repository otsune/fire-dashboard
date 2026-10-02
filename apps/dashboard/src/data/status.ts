import type {
  Weather,
  Feed,
  Usage,
} from "../../../../packages/contracts/src/index";
export function deriveStatus(
  value: Weather | Feed | Usage,
  now: number,
): { label: string; stale: boolean } {
  const status = (label: string, stale = false) => ({ label, stale });
  const age = (s: string | null) => (s ? now - Date.parse(s) : Infinity);
  if (
    value.errorCode === "clock_skew" ||
    [value.receivedAt, value.capturedAt, value.sourceObservedAt].some(
      (t) => t && Date.parse(t) > now + 1000,
    )
  )
    return status("時刻要確認", true);
  if (value.status === "unconfigured") return status("未設定");
  if (value.status === "unsupported") return status("未対応");
  if (value.status === "missing") return status("未取得");
  if ("buckets" in value) {
    if (value.receivedAt && age(value.receivedAt) > 300000)
      return status("取得元に未接続", true);
    if (value.status === "error")
      return status(
        value.errorCode === "auth" ? "認証を確認" : "取得エラー",
        true,
      );
    if (
      value.buckets.some((b) =>
        b.windows.some((w) => w.resetsAt && Date.parse(w.resetsAt) <= now),
      )
    )
      return status("更新待ち", true);
    if (value.sourceObservedAt && age(value.sourceObservedAt) > 300000)
      return status("更新遅延", true);
    if (value.sourceObservedAt === null)
      return status("元データの鮮度不明", true);
  } else {
    const maxAge = "periods" in value ? 7200000 : 21600000;
    if (value.lastSuccessAt && age(value.lastSuccessAt) > maxAge)
      return status("更新遅延", true);
    if (
      "periods" in value &&
      value.periods.length > 0 &&
      value.periods.every((p) => Date.parse(p.endsAt) <= now)
    )
      return status("予報期限切れ", true);
    if (value.status === "error") return status("取得エラー", true);
  }
  return value.status === "stale"
    ? status("更新遅延", true)
    : status("更新済み");
}
export function formatTime(iso: string | null, timeZone: string): string {
  return iso
    ? new Intl.DateTimeFormat("ja-JP", {
        timeZone,
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(iso))
    : "未取得";
}
