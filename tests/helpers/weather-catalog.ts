export const forecast = [
  {
    reportDatetime: "2026-10-03T05:00:00+09:00",
    timeSeries: [
      {
        timeDefines: ["2026-10-03T00:00:00+09:00"],
        areas: [
          {
            area: { code: "130010", name: "東京地方" },
            weathers: ["晴れ"],
            weatherCodes: ["100"],
          },
          { area: { code: "130020", name: "降水のみ" }, pops: ["20"] },
        ],
      },
      {
        timeDefines: ["2026-10-03T00:00:00+09:00"],
        areas: [
          {
            area: { code: "44132", name: "東京" },
            tempsMin: ["18"],
            tempsMax: ["25"],
          },
          { area: { code: "44133", name: "別地点" }, tempsMax: ["26"] },
          { area: { code: "44134", name: "未対応" }, temps: ["27"] },
        ],
      },
    ],
  },
];
export const response = (data: unknown) => ({
  body: Buffer.from(JSON.stringify(data)),
  status: 200,
  etag: null,
  lastModified: null,
  retryAfterMs: null,
});
