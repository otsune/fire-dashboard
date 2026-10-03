import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { expect, it } from "vitest";
import { createTailscaleAuth } from "../../services/aggregator/src/auth-tailscale";
import {
  emptyWeather,
  weatherSchema,
} from "../../packages/contracts/src/index";

const token = "t".repeat(40);
const options = {
  readerLogins: ["reader@example", "admin@example"],
  adminLogins: ["admin@example", "outsider@example"],
  collectorTokenHashes: {
    pc: createHash("sha256").update(token).digest("hex"),
  },
};
const request = (headers: Record<string, string>) =>
  ({ headers }) as FastifyRequest;
it("defaults legacy Weather configurationRevision to null", () => {
  const legacy = { ...emptyWeather() } as Record<string, unknown>;
  delete legacy.configurationRevision;
  expect(weatherSchema.parse(legacy).configurationRevision).toBeNull();
  expect(emptyWeather().configurationRevision).toBeNull();
});
it("keeps admin authorization separate and requires both explicit allowlists", async () => {
  const auth = createTailscaleAuth(options);
  expect(typeof auth.authorizeAdmin).toBe("function");
  for (const login of [
    "reader@example",
    "outsider@example",
    "unknown@example",
    "",
  ]) {
    expect(
      await auth.authorizeAdmin(request({ "tailscale-user-login": login })),
    ).toBe(false);
  }
  expect(
    await auth.authorizeAdmin(
      request({ "tailscale-user-login": "admin@example" }),
    ),
  ).toBe(true);
  expect(
    await auth.authorize(
      request({ "tailscale-user-login": "admin@example" }),
      "reader",
    ),
  ).toBe(true);
});
it.each(["", `Bearer ${token}`, "Basic anything"])(
  "denies admin whenever Authorization is present (%s)",
  async (authorization) => {
    const auth = createTailscaleAuth(options);
    expect(
      await auth.authorizeAdmin(
        request({ "tailscale-user-login": "admin@example", authorization }),
      ),
    ).toBe(false);
  },
);
it("admin defaults deny without changing collector access", async () => {
  const { adminLogins: _admins, ...legacy } = options;
  const auth = createTailscaleAuth(legacy);
  expect(
    await auth.authorizeAdmin(
      request({ "tailscale-user-login": "admin@example" }),
    ),
  ).toBe(false);
  expect(
    await auth.authorize(
      request({ authorization: `Bearer ${token}` }),
      "collector",
    ),
  ).toBe(true);
});
