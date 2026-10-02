import {
  parseDashboard,
  type Dashboard,
} from "../../../../packages/contracts/src/index";
export async function fetchDashboard(signal: AbortSignal): Promise<Dashboard> {
  const response = await fetch("/api/v1/dashboard", {
    signal,
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw Error(response.status === 401 ? "auth" : "network");
  const body = await response.text();
  if (body.length > 2 * 1024 * 1024) throw Error("too_large");
  return parseDashboard(JSON.parse(body));
}
