import { expect, it } from "vitest";
import { createServer } from "../../services/aggregator/src/server";
import { createMemoryStore } from "../../services/aggregator/src/store";
import { initializeWeatherSettings } from "../../services/aggregator/src/weather/settings";
import {
  createWeatherCatalog,
  JMA_AREA_URL,
} from "../../services/aggregator/src/weather/catalog";
import { forecast, response } from "../helpers/weather-catalog";
const origin = "https://dashboard.example";
const selection = { office: "130000", region: "130010", station: "44132" };
async function harness(adminConfigured = true) {
  const store = createMemoryStore();
  const initial = await initializeWeatherSettings(store, null);
  const requests: string[] = [],
    roles: string[] = [];
  const weatherCatalog = createWeatherCatalog({
    fetch: async (url) => {
      requests.push(url.href);
      return response(
        url.href === JMA_AREA_URL
          ? { offices: { "130000": { name: "東京都" } } }
          : forecast,
      );
    },
  });
  const app = createServer({
    store,
    weatherCatalog,
    allowedOrigins: [origin],
    authorize: async (req, role) => {
      roles.push(role);
      return (
        req.headers["x-role"] === role ||
        (req.headers["x-role"] === "admin" && role === "reader")
      );
    },
    ...(adminConfigured
      ? { authorizeAdmin: async (req) => req.headers["x-role"] === "admin" }
      : {}),
  });
  return { app, store, initial, requests, roles };
}
it.each(["reader", "collector", undefined])(
  "denies catalog and save for %s before expensive work",
  async (role) => {
    const { app, initial, requests, roles } = await harness();
    const headers = { origin, ...(role ? { "x-role": role } : {}) };
    try {
      const catalog = await app.inject({
        url: "/api/v1/weather-catalog",
        headers,
      });
      const save = await app.inject({
        method: "PUT",
        url: "/api/v1/weather-settings",
        headers,
        payload: { revision: initial.revision, selection },
      });
      expect(catalog.statusCode).toBe(role ? 403 : 401);
      expect(save.statusCode).toBe(role ? 403 : 401);
      expect(requests).toEqual([]);
      expect(
        roles.every((value) => value === "reader" || value === "collector"),
      ).toBe(true);
    } finally {
      await app.close();
    }
  },
);
it("legacy two-role authorize cannot grant admin by treating any non-collector role as reader", async () => {
  const { app, initial, requests } = await harness(false);
  try {
    expect(
      (
        await app.inject({
          url: "/api/v1/weather-settings",
          headers: { "x-role": "reader" },
        })
      ).json().canEdit,
    ).toBe(false);
    expect(
      (
        await app.inject({
          url: "/api/v1/weather-catalog",
          headers: { "x-role": "reader" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/weather-settings",
          headers: { "x-role": "reader", origin },
          payload: { revision: initial.revision, selection },
        })
      ).statusCode,
    ).toBe(403);
    expect(requests).toEqual([]);
  } finally {
    await app.close();
  }
});
it("returns canonical saved settings and weather labels to readers with no catalog access", async () => {
  const { app, initial } = await harness();
  try {
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/weather-settings",
      headers: { "x-role": "admin", origin },
      payload: { revision: initial.revision, selection },
    });
    expect(saved.statusCode).toBe(200);
    const read = await app.inject({
      url: "/api/v1/weather-settings",
      headers: { "x-role": "reader" },
    });
    expect(read.json()).toEqual({
      ...saved.json().settings,
      canEdit: false,
      weather: saved.json().weather,
    });
    expect(read.json().weather.regionLabel).toBe("東京地方");
    expect(
      (
        await app.inject({
          url: "/api/v1/weather-settings",
          headers: { "x-role": "admin" },
        })
      ).json().canEdit,
    ).toBe(true);
  } finally {
    await app.close();
  }
});
it("admin may fetch offices and office-specific options", async () => {
  const { app } = await harness();
  try {
    const offices = await app.inject({
      url: "/api/v1/weather-catalog",
      headers: { "x-role": "admin" },
    });
    expect(offices.statusCode).toBe(200);
    expect(offices.json()).toEqual({
      offices: [{ id: "130000", label: "東京都" }],
    });
    const office = await app.inject({
      url: "/api/v1/weather-catalog?office=130000",
      headers: { "x-role": "admin" },
    });
    expect(office.statusCode).toBe(200);
    expect(
      office.json().stations.map((value: { id: string }) => value.id),
    ).toEqual(["44132", "44133"]);
  } finally {
    await app.close();
  }
});
it.each([
  undefined,
  "null",
  "https://evil.example",
  "https://dashboard.example/",
])("PUT requires exact non-null Origin (%s)", async (badOrigin) => {
  const { app, initial, requests } = await harness();
  try {
    const result = await app.inject({
      method: "PUT",
      url: "/api/v1/weather-settings",
      headers: {
        "x-role": "admin",
        ...(badOrigin ? { origin: badOrigin } : {}),
      },
      payload: { revision: initial.revision, selection },
    });
    expect(result.statusCode).toBe(403);
    expect(result.json().error).toBe("origin_denied");
    expect(requests).toEqual([]);
  } finally {
    await app.close();
  }
});
it.each(["", "Bearer secret"])(
  "presence of Authorization excludes admin (%s)",
  async (authorization) => {
    const { app, initial, requests } = await harness();
    try {
      const headers = { "x-role": "admin", origin, authorization };
      expect(
        (await app.inject({ url: "/api/v1/weather-catalog", headers }))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/v1/weather-settings",
            headers,
            payload: { revision: initial.revision, selection },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ url: "/api/v1/weather-settings", headers })).json()
          .canEdit,
      ).toBe(false);
      expect(requests).toEqual([]);
    } finally {
      await app.close();
    }
  },
);
it("PUT requires JSON and rejects malformed, extra and unknown IDs", async () => {
  const { app, initial, requests } = await harness();
  try {
    const headers = { "x-role": "admin", origin };
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/weather-settings",
          headers: { ...headers, "content-type": "text/plain" },
          payload: "x",
        })
      ).json(),
    ).toEqual({ error: "invalid_data" });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/weather-settings",
          headers: { ...headers, "content-type": "application/json" },
          payload: "{",
        })
      ).json(),
    ).toEqual({ error: "invalid_data" });
    for (const payload of [
      {
        revision: initial.revision,
        selection: { ...selection, office: "../bad" },
      },
      { revision: initial.revision, selection, canEdit: true },
      {
        revision: initial.revision,
        selection: { ...selection, region: "999999" },
      },
      {
        revision: initial.revision,
        selection: { ...selection, station: "44134" },
      },
    ]) {
      const result = await app.inject({
        method: "PUT",
        url: "/api/v1/weather-settings",
        headers,
        payload,
      });
      expect(result.statusCode).toBe(400);
      expect(result.json()).toEqual({ error: "invalid_data" });
    }
    expect(requests).toHaveLength(2);
  } finally {
    await app.close();
  }
});
it("returns revision conflict and preserves first committed save", async () => {
  const { app, initial, store } = await harness();
  try {
    const request = {
      method: "PUT" as const,
      url: "/api/v1/weather-settings",
      headers: { "x-role": "admin", origin },
      payload: { revision: initial.revision, selection },
    };
    const first = await app.inject(request);
    const second = await app.inject(request);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "revision_conflict" });
    expect((await store.readState()).weatherSettings).toEqual(
      first.json().settings,
    );
  } finally {
    await app.close();
  }
});
it("catalog failures are sanitized, retryable 503s", async () => {
  const store = createMemoryStore();
  const initial = await initializeWeatherSettings(store, null);
  const app = createServer({
    store,
    allowedOrigins: [origin],
    authorize: async () => true,
    authorizeAdmin: async () => true,
    weatherCatalog: createWeatherCatalog({
      fetch: async () => {
        throw Error("secret=oops");
      },
    }),
  });
  try {
    for (const result of [
      await app.inject({ url: "/api/v1/weather-catalog" }),
      await app.inject({
        method: "PUT",
        url: "/api/v1/weather-settings",
        headers: { origin },
        payload: { revision: initial.revision, selection },
      }),
    ]) {
      expect(result.statusCode).toBe(503);
      expect(result.json()).toEqual({ error: "catalog_unavailable" });
    }
  } finally {
    await app.close();
  }
});
it("uninitialized or failed storage returns sanitized settings 503", async () => {
  const app = createServer({
    store: createMemoryStore(),
    authorize: async () => true,
  });
  try {
    const result = await app.inject({ url: "/api/v1/weather-settings" });
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({ error: "storage_unavailable" });
  } finally {
    await app.close();
  }
});
it.each(["reader", "collector", undefined])(
  "HEAD catalog endpoints remain admin-only for %s before network work",
  async (role) => {
    const { app, requests } = await harness(false);
    try {
      for (const url of [
        "/api/v1/weather-catalog",
        "/api/v1/weather-catalog?office=130000",
      ]) {
        const result = await app.inject({
          method: "HEAD",
          url,
          headers: role ? { "x-role": role } : {},
        });
        expect(result.statusCode).toBe(role ? 403 : 401);
        expect(requests).toEqual([]);
      }
      const dashboard = await app.inject({
        method: "HEAD",
        url: "/api/v1/dashboard",
        headers: { "x-role": "reader" },
      });
      expect(dashboard.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  },
);
