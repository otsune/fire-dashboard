import { it, expect } from "vitest";
import {
  safeFetch,
  isPublicAddress,
  type Transport,
} from "../../services/aggregator/src/fetch/safe-fetch";
import {
  nextDelay,
  createSingleFlight,
} from "../../services/aggregator/src/fetch/schedule";
const policy = {
  allowedHostsPaths: ["https://news.example/rss"],
  timeoutMs: 10000,
  maxBytes: 2 * 1024 * 1024,
};
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const response = (
  body = "ok",
  status = 200,
  headers: Record<string, string> = {},
) => ({ body: Buffer.from(body), status, headers });
it.each([
  "127.0.0.1",
  "10.0.0.1",
  "172.16.0.1",
  "192.168.2.1",
  "169.254.169.254",
  "100.100.100.200",
  "0.0.0.0",
  "::1",
  "fc00::1",
  "fe80::1",
  "::ffff:127.0.0.1",
  "2001:db8::1",
  "224.0.0.1",
])("rejects nonpublic %s", (ip) => expect(isPublicAddress(ip)).toBe(false));
it("pins the validated DNS result and preserves hostname", async () => {
  let pinned = "";
  const transport: Transport = async (url, address) => {
    pinned = address.address;
    expect(url.hostname).toBe("news.example");
    return response();
  };
  const r = await safeFetch(new URL("https://news.example/rss"), policy, {
    lookup,
    transport,
  });
  expect(pinned).toBe("93.184.216.34");
  expect(Buffer.from(r.body).toString()).toBe("ok");
});
it.each([
  "http://news.example/rss",
  "https://news.example/other",
  "https://a:b@news.example/rss",
  "https://news.example:444/rss",
])("rejects URL outside policy %s", (url) =>
  expect(
    safeFetch(new URL(url), policy, {
      lookup,
      transport: async () => response(),
    }),
  ).rejects.toThrow(),
);
it("rejects any private DNS answer and unsafe redirect", async () => {
  await expect(
    safeFetch(new URL("https://news.example/rss"), policy, {
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      transport: async () => response(),
    }),
  ).rejects.toThrow("blocked");
  await expect(
    safeFetch(new URL("https://news.example/rss"), policy, {
      lookup,
      transport: async () =>
        response("", 302, { location: "http://169.254.169.254/latest" }),
    }),
  ).rejects.toThrow("blocked");
});
it("revalidates every redirect DNS address", async () => {
  let n = 0;
  await expect(
    safeFetch(new URL("https://news.example/rss"), policy, {
      lookup: async () => [
        { address: ++n === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 },
      ],
      transport: async () => response("", 302, { location: "/rss" }),
    }),
  ).rejects.toThrow("blocked");
  expect(n).toBe(2);
});
it("limits redirects, expanded bytes and total timeout", async () => {
  await expect(
    safeFetch(new URL("https://news.example/rss"), policy, {
      lookup,
      transport: async () => response("", 302, { location: "/rss" }),
    }),
  ).rejects.toThrow("redirect");
  await expect(
    safeFetch(
      new URL("https://news.example/rss"),
      { ...policy, maxBytes: 4 },
      { lookup, transport: async () => response("12345") },
    ),
  ).rejects.toThrow("too_large");
  await expect(
    safeFetch(
      new URL("https://news.example/rss"),
      { ...policy, timeoutMs: 10 },
      { lookup, transport: async () => new Promise(() => {}) },
    ),
  ).rejects.toThrow("timeout");
});
it("supports validators and 304 without inventing observation time", async () => {
  const r = await safeFetch(new URL("https://news.example/rss"), policy, {
    lookup,
    etag: '"one"',
    transport: async (_url, _ip, _signal, headers) => {
      expect(headers["If-None-Match"]).toBe('"one"');
      return response("", 304, { etag: '"one"' });
    },
  });
  expect(r.status).toBe(304);
  expect(r.etag).toBe('"one"');
  expect(r.body.length).toBe(0);
});
it("backs off 1/5/15/30 minutes and caps jitter at 10 percent", () => {
  expect([1, 2, 3, 4, 10].map((a) => nextDelay(a, 1800000, () => 0))).toEqual([
    60000, 300000, 900000, 1800000, 1800000,
  ]);
  expect(nextDelay(1, 1800000, () => 1)).toBe(66000);
  expect(nextDelay(1, 1800000, () => 0, 3600000)).toBe(3600000);
});
it("coalesces concurrent external updates", async () => {
  let calls = 0;
  const work = createSingleFlight(async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return calls;
  });
  expect(await Promise.all([work(), work()])).toEqual([1, 1]);
  expect(calls).toBe(1);
});
