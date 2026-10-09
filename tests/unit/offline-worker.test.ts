import { it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const origin = "https://dashboard.example";
const shellAssets = [
  "/index.html",
  "/assets/app.js",
  "/assets/app.css",
  "/font.woff2",
];
type Stored = { request: Request; response: Response };
type QueryOptions = { ignoreSearch?: boolean; ignoreVary?: boolean };
function request(path: string, init: RequestInit = {}) {
  return new Request(new URL(path, origin), init);
}
function worker(
  options: { fail?: boolean; offline?: boolean; assets?: string[] } = {},
) {
  const handlers: Record<string, (event: any) => void> = {};
  const stores = new Map<string, Map<string, Stored>>();
  const deleted: string[] = [];
  let skipped = 0;
  let claimed = 0;
  const store = (name: string) => {
    let value = stores.get(name);
    if (!value) {
      value = new Map();
      stores.set(name, value);
    }
    return value;
  };
  const put = (name: string, input: Request | string, response: Response) => {
    const key = typeof input === "string" ? request(input) : input;
    store(name).set(key.url, { request: key.clone(), response });
  };
  put("fire-shell-previous", "/index.html", new Response("previous shell"));
  put("unrelated-cache", "/other", new Response("unrelated"));
  const caches = {
    open: async (name: string) => ({
      addAll: async (assets: string[]) => {
        // Cache.addAll stores the original Request keys, without a page Origin.
        for (const asset of assets) {
          const key = request(asset);
          put(
            name,
            key,
            new Response("asset:" + new URL(key.url).pathname, {
              headers: { Vary: "Origin", "content-type": "text/plain" },
            }),
          );
          if (options.fail) throw Error("missing_asset");
        }
      },
      put: async (input: Request | string, response: Response) =>
        put(name, input, response),
      match: async (
        input: Request | string,
        queryOptions: QueryOptions = {},
      ) => {
        const query = typeof input === "string" ? request(input) : input;
        if (query.method !== "GET") return undefined;
        for (const value of store(name).values()) {
          const queryURL = new URL(query.url);
          const storedURL = new URL(value.request.url);
          if (queryOptions.ignoreSearch) {
            queryURL.search = "";
            storedURL.search = "";
          }
          if (queryURL.href !== storedURL.href) continue;
          const vary = value.response.headers.get("vary");
          if (
            vary &&
            !queryOptions.ignoreVary &&
            vary
              .split(",")
              .some(
                (field) =>
                  field.trim() === "*" ||
                  query.headers.get(field.trim()) !==
                    value.request.headers.get(field.trim()),
              )
          )
            continue;
          return value.response.clone();
        }
        return undefined;
      },
    }),
    delete: async (name: string) => {
      deleted.push(name);
      return stores.delete(name);
    },
    keys: async () => [...stores.keys()],
  };
  const network = vi.fn(async () => {
    if (options.offline) throw Error("offline_network");
    return new Response("network");
  });
  const self = {
    location: { origin },
    addEventListener: (type: string, fn: (event: any) => void) =>
      (handlers[type] = fn),
    skipWaiting: async () => {
      skipped++;
    },
    clients: {
      claim: async () => {
        claimed++;
      },
    },
  };
  runInNewContext(
    readFileSync("apps/dashboard/src/sw.ts", "utf8")
      .replace("__VERSION__", "test")
      .replace("__ASSETS__", JSON.stringify(options.assets ?? shellAssets)),
    { self, caches, Response, URL, fetch: network },
  );
  return {
    dispatch: (type: string, extra: Record<string, unknown> = {}) => {
      let pending: Promise<unknown> | undefined;
      handlers[type]({
        waitUntil: (value: Promise<unknown>) => {
          pending = value;
        },
        ...extra,
      });
      return pending ?? Promise.resolve();
    },
    fetch: (input: Request) => {
      let answered: Promise<Response> | undefined;
      handlers.fetch({
        request: input,
        respondWith: (value: Promise<Response>) => {
          answered = value;
        },
      });
      return answered;
    },
    put: (input: Request | string, response: Response) =>
      put("fire-shell-test", input, response),
    stores,
    deleted,
    network,
    getSkipped: () => skipped,
    getClaimed: () => claimed,
  };
}

it("does not activate a partial new shell or delete the old complete cache", async () => {
  const w = worker({ fail: true });
  await expect(w.dispatch("install")).rejects.toThrow("missing_asset");
  expect(w.stores.has("fire-shell-test")).toBe(false);
  expect(w.deleted).toEqual(["fire-shell-test"]);
  expect(
    w.stores.get("fire-shell-previous")?.get(request("/index.html").url)
      ?.response,
  ).toBeDefined();
  await w.dispatch("message", { data: "ACTIVATE_UPDATE" });
  await w.dispatch("activate");
  expect(w.getSkipped()).toBe(0);
  expect(w.getClaimed()).toBe(0);
  expect(w.deleted).toEqual(["fire-shell-test"]);
});
it("only activates complete updates after explicit action and preserves unrelated caches", async () => {
  const w = worker();
  await w.dispatch("install");
  expect(
    w.stores.get("fire-shell-test")?.has(request("/__complete__").url),
  ).toBe(true);
  expect(w.getSkipped()).toBe(0);
  await w.dispatch("message", { data: "ACTIVATE_UPDATE" });
  expect(w.getSkipped()).toBe(1);
  await w.dispatch("activate");
  expect(w.deleted).toEqual(["fire-shell-previous"]);
  expect(w.stores.has("unrelated-cache")).toBe(true);
  expect(w.getClaimed()).toBe(1);
});
it.each(["/assets/app.js", "/assets/app.css"])(
  "loads precached %s offline when page Origin differs from the stored request",
  async (path) => {
    const w = worker({ offline: true });
    await w.dispatch("install");
    const cached = w.stores.get("fire-shell-test")!.get(request(path).url)!;
    expect(cached.request.headers.get("origin")).toBeNull();
    expect(cached.response.headers.get("vary")).toBe("Origin");
    const response = await w.fetch(
      request(path, { headers: { Origin: origin } }),
    );
    expect(await response!.text()).toBe("asset:" + path);
    expect(w.network).not.toHaveBeenCalled();
  },
);
it("serves declared assets without Origin and retains ignoreSearch", async () => {
  const w = worker({ offline: true });
  await w.dispatch("install");
  const response = await w.fetch(request("/assets/app.js?reload=1"));
  expect(await response!.text()).toBe("asset:/assets/app.js");
  expect(w.network).not.toHaveBeenCalled();
});
it("normalizes declared Windows asset separators before matching", async () => {
  const w = worker({ offline: true, assets: ["/assets\\app.js"] });
  await w.dispatch("install");
  const response = await w.fetch(
    request("/assets/app.js", { headers: { Origin: origin } }),
  );
  expect(await response!.text()).toBe("asset:/assets/app.js");
  expect(w.network).not.toHaveBeenCalled();
});
it("does not ignore Vary for an undeclared same-origin resource", async () => {
  const w = worker({ offline: true });
  w.put(
    "/unknown.js",
    new Response("not a shell asset", { headers: { Vary: "Origin" } }),
  );
  await expect(
    w.fetch(request("/unknown.js", { headers: { Origin: origin } })),
  ).rejects.toThrow("offline_network");
  expect(w.network).toHaveBeenCalledOnce();
});
it("keeps ordinary unknown-resource cache matching without populating runtime caches", async () => {
  const w = worker();
  w.put(
    "/unknown.js",
    new Response("cached unknown", { headers: { Vary: "Origin" } }),
  );
  expect(await (await w.fetch(request("/unknown.js")))!.text()).toBe(
    "cached unknown",
  );
  expect(w.network).not.toHaveBeenCalled();
  expect(await (await w.fetch(request("/uncached.js")))!.text()).toBe(
    "network",
  );
  expect(w.network).toHaveBeenCalledOnce();
  expect(
    w.stores.get("fire-shell-test")?.has(request("/uncached.js").url),
  ).toBe(false);
});
it.each([
  { url: "/api/v1/dashboard", method: "GET" },
  { url: "/assets/app.js", method: "POST" },
  { url: "https://evil.example/assets/app.js", method: "GET" },
])("does not intercept $method $url", ({ url, method }) => {
  const w = worker();
  expect(w.fetch(request(url, { method }))).toBeUndefined();
  expect(w.network).not.toHaveBeenCalled();
});
it("does not treat cross-origin declarations as same-origin shell assets", async () => {
  const w = worker({
    offline: true,
    assets: ["https://evil.example/unknown.js"],
  });
  w.put(
    "/unknown.js",
    new Response("unknown", { headers: { Vary: "Origin" } }),
  );
  await expect(
    w.fetch(request("/unknown.js", { headers: { Origin: origin } })),
  ).rejects.toThrow("offline_network");
});
it.each([false, true])(
  "answers offline navigation with a usable shell (redirected=%s)",
  async (redirected) => {
    const w = worker({ offline: true });
    const shell = new Response("<!doctype html>shell", {
      status: 200,
      headers: { "content-type": "text/html", Vary: "Origin" },
    });
    Object.defineProperty(shell, "redirected", { value: redirected });
    // A real redirected response preserves redirected when cloned.
    if (redirected) {
      const clone = shell.clone.bind(shell);
      shell.clone = () => {
        const value = clone();
        Object.defineProperty(value, "redirected", { value: true });
        return value;
      };
    }
    w.put("/index.html", shell);
    const navigation = request("/");
    Object.defineProperty(navigation, "mode", { value: "navigate" });
    const response = await w.fetch(navigation);
    expect(response!.redirected).toBe(false);
    expect(response!.status).toBe(200);
    expect(response!.headers.get("content-type")).toBe("text/html");
    expect(await response!.text()).toBe("<!doctype html>shell");
    expect(w.network).not.toHaveBeenCalled();
  },
);
it("retains the navigation network fallback when no shell was cached", async () => {
  const w = worker();
  const navigation = request("/");
  Object.defineProperty(navigation, "mode", { value: "navigate" });
  expect(await (await w.fetch(navigation))!.text()).toBe("network");
  expect(w.network).toHaveBeenCalledOnce();
});
