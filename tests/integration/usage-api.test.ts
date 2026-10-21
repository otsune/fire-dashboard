import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createUsageServer } from "../../services/usage/src/server";
import { createMemoryUsageStore } from "../../services/usage/src/store";
import { createTailscaleAuth } from "../../services/usage/src/auth-tailscale";
import { usageEnvelope } from "../helpers/usage";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const collector = "c".repeat(43),
  reader = "r".repeat(43);
export function usageApi() {
  return createUsageServer({
    store: createMemoryUsageStore(),
    ...createTailscaleAuth({
      readerLogins: ["me@example.com"],
      readerTokenHashes: [hash(reader)],
      collectorTokenHashes: { desk: hash(collector) },
    }),
    preferredSources: { claude: "desk" },
    allowedOrigins: ["https://dashboard.example"],
  });
}
it("provides canonical usage without any Fire routes and enforces distinct credentials", async () => {
  const s = usageApi();
  try {
    expect((await s.inject({ url: "/api/v1/usage" })).statusCode).toBe(401);
    expect(
      (
        await s.inject({
          url: "/api/v1/usage",
          headers: { authorization: `Bearer ${collector}` },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await s.inject({
          method: "POST",
          url: "/api/v1/usage",
          payload: usageEnvelope(1),
          headers: { authorization: `Bearer ${reader}` },
        })
      ).statusCode,
    ).toBe(403);
    const posted = await s.inject({
      method: "POST",
      url: "/api/v1/usage",
      payload: usageEnvelope(1),
      headers: { authorization: `Bearer ${collector}` },
    });
    expect(posted.json()).toEqual({ status: "accepted" });
    const result = await s.inject({
      url: "/api/v1/usage",
      headers: { authorization: `Bearer ${reader}` },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      schemaVersion: 1,
      revision: "1",
      usage: expect.arrayContaining([
        expect.objectContaining({ provider: "claude", sourceAlias: "desk" }),
      ]),
    });
    expect(result.json()).not.toHaveProperty("weather");
    expect(
      (
        await s.inject({
          url: "/api/v1/dashboard",
          headers: { authorization: `Bearer ${reader}` },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await s.inject({
          url: "/api/v1/usage",
          headers: {
            authorization: `Bearer ${reader}`,
            origin: "https://evil.example",
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await s.inject({
          method: "POST",
          url: "/api/v1/usage",
          payload: usageEnvelope(1, "note"),
          headers: { authorization: `Bearer ${collector}` },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await s.inject({
          method: "POST",
          url: "/api/v1/usage",
          payload: { x: "x".repeat(66000) },
          headers: { authorization: `Bearer ${collector}` },
        })
      ).statusCode,
    ).toBe(413);
  } finally {
    await s.close();
  }
});
