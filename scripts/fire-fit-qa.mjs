#!/usr/bin/env node
/**
 * Local-only visual QA harness. All dashboard data is synthetic.
 * Run after npm run build; this script needs only Node, not project dependencies.
 * Usage: node scripts/fire-fit-qa.mjs [two|five|unconfigured|error] [port] [dist]
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const scenarios = ["two", "five", "unconfigured", "error"];
const providers = [
  "claude",
  "codex",
  "antigravity",
  "opencode_go",
  "hermes_nous",
];

export function dashboardFixture(scenario = "five", now = new Date()) {
  if (!scenarios.includes(scenario)) {
    throw new Error(
      `Unknown scenario: ${scenario}. Choose ${scenarios.join(", ")}.`,
    );
  }
  const stamp = now.toISOString();
  const instant = (hours) =>
    new Date(now.getTime() + hours * 3_600_000).toISOString();
  const common = (status = "unconfigured") => ({
    schemaVersion: 1,
    status,
    sourceObservedAt: null,
    capturedAt: null,
    receivedAt: null,
    freshness: "unknown",
    lastSuccessAt: null,
    errorCode: null,
  });
  const fresh = {
    ...common("ok"),
    sourceObservedAt: stamp,
    capturedAt: stamp,
    receivedAt: stamp,
    freshness: "known",
    lastSuccessAt: stamp,
  };
  const data = {
    schemaVersion: 1,
    weather: {
      ...common(),
      provider: "jma",
      regionId: null,
      regionLabel: null,
      temperatureStationLabel: null,
      issuedAt: null,
      periods: [],
    },
    rss: [],
    usage: providers.map((provider) => ({
      ...common(),
      provider,
      sourceAlias: "",
      buckets: [],
    })),
  };
  if (scenario === "unconfigured") return data;

  data.weather = {
    ...data.weather,
    ...fresh,
    regionId: "130010",
    regionLabel: "東京都 東京地方",
    temperatureStationLabel: "東京（気温の代表地点・テスト用）",
    issuedAt: stamp,
    periods: Array.from({ length: 4 }, (_, index) => ({
      startsAt: instant(index * 6),
      endsAt: instant((index + 1) * 6),
      summary: index === 0 ? "晴れ時々くもり" : `詳細予報 ${index + 1}`,
      weatherCode: "101",
      temperatureMinC: 19 + index,
      temperatureMaxC: 27 + index,
      precipitationProbabilityPct: 20 + index * 10,
    })),
  };
  data.rss = [
    {
      ...fresh,
      id: "fit-feed",
      label: "画面サイズ確認用フィード（架空）",
      items: Array.from({ length: 8 }, (_, index) => ({
        id: `headline-${index}`,
        title:
          index === 0
            ? "地域の天気と今日のニュースを確認するための長い見出し。画面幅を超えて他のカードを押し広げないことを確認します"
            : `詳細で読めるニュース ${index + 1}`,
        url: `https://example.com/news/${index}`,
        publishedAt: stamp,
        sourceLabel: "確認用ニュース（架空）",
      })),
    },
  ];
  const count = scenario === "two" ? 2 : 5;
  data.usage = data.usage.map((usage, index) => {
    if (index >= count) return usage;
    const configured = {
      ...usage,
      ...fresh,
      sourceAlias: `fixture-${usage.provider}-source`,
    };
    if (usage.provider === "hermes_nous")
      return {
        ...configured,
        balance: {
          currency: "USD",
          subscriptionRemaining: 25,
          purchasedRemaining: 12,
          totalRemaining: 37,
          monthlyAllowance: 20,
          renewsAt: instant(24),
        },
      };
    return {
      ...configured,
      buckets: Array.from({ length: 2 }, (_, bucket) => ({
        id: `bucket-${bucket}`,
        label: `長い名前の利用枠 ${bucket + 1}`,
        windows: Array.from({ length: 4 }, (_, window) => ({
          id: `window-${window}`,
          label: `利用期間と集計対象を説明する長いラベル ${window + 1}`,
          usedPercent: [42, 77, 0, 100][index],
          windowMinutes: (window + 1) * 300,
          resetsAt: instant(window + 1),
        })),
      })),
    };
  });
  if (scenario === "error") {
    Object.assign(data.weather, {
      status: "error",
      errorCode: "network",
      periods: [],
    });
    data.rss = data.rss.map((feed) => ({
      ...feed,
      status: "error",
      errorCode: "timeout",
      items: [],
    }));
    data.usage = data.usage.map(({ balance: _balance, ...usage }, index) => ({
      ...usage,
      status: "error",
      errorCode: index === 0 ? "auth" : "network",
      buckets: [],
    }));
  }
  return data;
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function createQaServer({ scenario = "five", dist }) {
  // Validate configuration without binding a socket or reading private data.
  dashboardFixture(scenario);
  const root = resolve(dist);
  return createServer(async (request, response) => {
    const send = (status, contentType, body) => {
      response.writeHead(status, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(405, "text/plain; charset=utf-8", "Read-only QA server");
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === "/api/v1/dashboard") {
        send(
          200,
          mimeTypes[".json"],
          JSON.stringify(dashboardFixture(scenario)),
        );
        return;
      }
      if (pathname === "/audio/manifest.json") {
        send(
          200,
          mimeTypes[".json"],
          JSON.stringify({ hours: {}, chime: null }),
        );
        return;
      }
      // Do not install a service worker that could leak a scenario between runs.
      if (pathname === "/sw.js") {
        send(
          404,
          "text/plain; charset=utf-8",
          "Service workers disabled for QA",
        );
        return;
      }
      if (pathname.includes("\0")) {
        send(400, "text/plain; charset=utf-8", "Invalid path");
        return;
      }
      let file = resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(root + sep)) {
        send(403, "text/plain; charset=utf-8", "Outside the QA build");
        return;
      }
      if (file === root || pathname.endsWith("/"))
        file = resolve(file, "index.html");
      try {
        if (!(await stat(file)).isFile()) throw new Error("Not a file");
      } catch {
        if (extname(pathname)) {
          send(404, "text/plain; charset=utf-8", "Not found");
          return;
        }
        file = resolve(root, "index.html");
      }
      send(
        200,
        mimeTypes[extname(file)] ?? "application/octet-stream",
        await readFile(file),
      );
    } catch (error) {
      send(
        error instanceof URIError ? 400 : 500,
        "text/plain; charset=utf-8",
        "Could not serve this QA request",
      );
    }
  });
}

const script = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === script) {
  const [scenario = "five", portText = "4173", distArgument] =
    process.argv.slice(2);
  const port = Number(portText);
  if (
    !scenarios.includes(scenario) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  ) {
    console.error(
      "Usage: node scripts/fire-fit-qa.mjs [two|five|unconfigured|error] [port:1024–65535] [dist-directory]",
    );
    process.exitCode = 1;
  } else {
    const dist =
      distArgument ?? resolve(dirname(script), "../apps/dashboard/dist");
    const server = createQaServer({ scenario, dist });
    server.on("error", (error) => {
      console.error(`QA server could not start: ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(port, "127.0.0.1", () => {
      console.log(`Synthetic ${scenario} dashboard: http://127.0.0.1:${port}`);
      console.log(`Static build: ${resolve(dist)}`);
    });
  }
}
