import { lookup as dnsLookup } from "node:dns/promises";
import { request } from "node:https";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import ipaddr from "ipaddr.js";
export type FetchPolicy = {
  allowedHostsPaths: string[];
  timeoutMs: number;
  maxBytes: number;
};
type Address = { address: string; family: number };
type ResponseData = {
  body: Uint8Array;
  status: number;
  headers: Record<string, string>;
};
export type Transport = (
  url: URL,
  address: Address,
  signal: AbortSignal,
  headers: Record<string, string>,
  maxBytes: number,
) => Promise<ResponseData>;
export function isPublicAddress(value: string): boolean {
  try {
    const address = ipaddr.parse(value);
    return (
      address.range() === "unicast" &&
      !(
        address.kind() === "ipv6" &&
        (address as ipaddr.IPv6).isIPv4MappedAddress()
      )
    );
  } catch {
    return false;
  }
}
function validateUrl(url: URL, policy: FetchPolicy) {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    throw Error("blocked");
  const match = policy.allowedHostsPaths.some((item) => {
    try {
      const allowed = new URL(
        item.startsWith("https://") ? item : `https://${item}`,
      );
      return (
        allowed.origin === url.origin &&
        allowed.pathname === url.pathname &&
        allowed.search === url.search
      );
    } catch {
      return false;
    }
  });
  if (!match) throw Error("blocked");
}
const networkTransport: Transport = (url, address, signal, headers, maxBytes) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        agent: false,
        servername: url.hostname,
        signal,
        headers: {
          "User-Agent": "FireDashboard/0.1",
          "Accept-Encoding": "gzip, br, deflate",
          ...headers,
        },
        lookup: ((_host: unknown, options: unknown, callback: Function) => {
          if ((options as { all?: boolean }).all) callback(null, [address]);
          else callback(null, address.address, address.family);
        }) as never,
      },
      (res) => {
        if (Number(res.headers["content-length"]) > maxBytes) {
          res.destroy();
          reject(Error("too_large"));
          return;
        }
        let total = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            reject(Error("too_large"));
          } else chunks.push(chunk);
        });
        res.on("error", () => reject(Error("network")));
        res.on("end", () => {
          try {
            const raw = Buffer.concat(chunks);
            const encoding = res.headers["content-encoding"];
            const options = { maxOutputLength: maxBytes };
            let body: Buffer;
            switch (encoding) {
              case undefined:
              case "identity":
                body = raw;
                break;
              case "gzip":
                body = gunzipSync(raw, options);
                break;
              case "deflate":
                body = inflateSync(raw, options);
                break;
              case "br":
                body = brotliDecompressSync(raw, options);
                break;
              default:
                throw Error("encoding");
            }
            const safeHeaders: Record<string, string> = {};
            for (const name of [
              "location",
              "etag",
              "last-modified",
              "retry-after",
            ]) {
              const value = res.headers[name];
              if (typeof value === "string" && value.length <= 2048)
                safeHeaders[name] = value;
            }
            resolve({
              body,
              status: res.statusCode ?? 0,
              headers: safeHeaders,
            });
          } catch {
            reject(Error("too_large"));
          }
        });
      },
    );
    req.on("error", () =>
      reject(Error(signal.aborted ? "timeout" : "network")),
    );
    req.end();
  });
export async function safeFetch(
  url: URL,
  policy: FetchPolicy,
  deps: {
    lookup?: (host: string) => Promise<Address[]>;
    transport?: Transport;
    etag?: string | null;
    lastModified?: string | null;
  } = {},
): Promise<{
  body: Uint8Array;
  status: number;
  etag: string | null;
  lastModified: string | null;
  retryAfterMs: number | null;
}> {
  if (!(
    policy.timeoutMs > 0 &&
    policy.timeoutMs <= 10000 &&
    policy.maxBytes > 0 &&
    policy.maxBytes <= 2 * 1024 * 1024
  ))
    throw Error("invalid_policy");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Error("timeout"));
    }, policy.timeoutMs);
  });
  const perform = async () => {
    let target = url;
    for (let redirects = 0; redirects <= 3; redirects++) {
      validateUrl(target, policy);
      const answers = await (
        deps.lookup ??
        ((host) => dnsLookup(host, { all: true, verbatim: true }))
      )(target.hostname);
      if (!answers.length || answers.some((a) => !isPublicAddress(a.address)))
        throw Error("blocked");
      if (controller.signal.aborted) throw Error("timeout");
      const headers: Record<string, string> = {};
      if (deps.etag && deps.etag.length <= 2048 && !/[\r\n]/.test(deps.etag))
        headers["If-None-Match"] = deps.etag;
      if (
        deps.lastModified &&
        deps.lastModified.length <= 2048 &&
        !/[\r\n]/.test(deps.lastModified)
      )
        headers["If-Modified-Since"] = deps.lastModified;
      const res = await (deps.transport ?? networkTransport)(
        target,
        answers[0],
        controller.signal,
        headers,
        policy.maxBytes,
      );
      if (res.body.length > policy.maxBytes) throw Error("too_large");
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        if (!res.headers.location) throw Error("redirect");
        target = new URL(res.headers.location, target);
        validateUrl(target, policy);
        continue;
      }
      const retry = res.headers["retry-after"];
      const retryAfterMs = retry
        ? /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : Math.max(0, Date.parse(retry) - Date.now())
        : null;
      return {
        body: res.body,
        status: res.status,
        etag: res.headers.etag ?? null,
        lastModified: res.headers["last-modified"] ?? null,
        retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : null,
      };
    }
    throw Error("redirect_limit");
  };
  try {
    return await Promise.race([perform(), timeout]);
  } finally {
    clearTimeout(timer!);
    controller.abort();
  }
}
