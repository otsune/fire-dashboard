import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GROK_USAGE_ENDPOINT,
  fetchGrokUsage,
  normalizeGrokUsage,
  parseGrokUsageResponse,
  readGrokAccessToken,
} from "../../collectors/grok/api";

const at = "2026-10-16T00:00:00.000Z";
const reset = Math.floor(Date.parse("2026-10-20T00:00:00.000Z") / 1000);

function varint(value: number): number[] {
  const bytes: number[] = [];
  do {
    const next = value % 128;
    value = Math.floor(value / 128);
    bytes.push(next | (value ? 128 : 0));
  } while (value);
  return bytes;
}
function field(field: number, wire: number, value: number[]): number[] {
  return [...varint(field * 8 + wire), ...value];
}
function message(...fields: number[][]): Uint8Array {
  return Uint8Array.from(fields.flat());
}
function nested(fieldNumber: number, value: Uint8Array): number[] {
  return field(fieldNumber, 2, [...varint(value.length), ...value]);
}
function grpcFrame(flags: number, value: Uint8Array): Uint8Array {
  return Uint8Array.from([
    flags,
    (value.length >>> 24) & 255,
    (value.length >>> 16) & 255,
    (value.length >>> 8) & 255,
    value.length & 255,
    ...value,
  ]);
}
function response() {
  const percent = new Uint8Array(4);
  new DataView(percent.buffer).setFloat32(0, 42.5, true);
  const timestamp = message(field(1, 0, varint(reset)));
  const payload = message(
    nested(1, message(field(1, 5, [...percent]), nested(5, timestamp))),
  );
  const trailer = new TextEncoder().encode("grpc-status: 0\r\n");
  return Uint8Array.from([
    ...grpcFrame(0, payload),
    ...grpcFrame(0x80, trailer),
  ]);
}
function zeroUsageResponse() {
  const timestamp = new Uint8Array(message(field(1, 0, varint(reset))));
  const period = message(nested(5, timestamp), field(6, 0, varint(1)));
  const payload = message(nested(1, period));
  return Uint8Array.from([
    ...grpcFrame(0, payload),
    ...grpcFrame(0x80, new TextEncoder().encode("grpc-status: 0\r\n")),
  ]);
}

function binaryResponse(value = response(), status = 200) {
  return new Response(value, {
    status,
    headers: { "content-type": "application/grpc-web+proto" },
  });
}

describe("Grok gRPC-web usage collector", () => {
  it("rejects unrelated percent/reset fields and ambiguous duplicate usage messages", () => {
    const percent = new Uint8Array(4);
    new DataView(percent.buffer).setFloat32(0, 99, true);
    const wrong = message(
      nested(
        2,
        message(
          field(1, 5, [...percent]),
          nested(5, message(field(1, 0, varint(reset)))),
        ),
      ),
    );
    expect(() => parseGrokUsageResponse(wrong, new Date(at))).toThrow(
      "invalid_data",
    );
    const noReset = message(nested(1, message(field(1, 5, [...percent]))));
    expect(() => parseGrokUsageResponse(noReset, new Date(at))).toThrow(
      "invalid_data",
    );
    const duplicate = Uint8Array.from([...response(), ...response()]);
    expect(() => parseGrokUsageResponse(duplicate, new Date(at))).toThrow(
      "invalid_data",
    );
  });
  it("extracts usage percent and the preferred reset timestamp", () => {
    expect(parseGrokUsageResponse(response(), new Date(at))).toEqual({
      usedPercent: 42.5,
      resetsAt: "2026-10-20T00:00:00.000Z",
    });
    expect(
      normalizeGrokUsage(parseGrokUsageResponse(response(), new Date(at)), at),
    ).toMatchObject({
      provider: "grok",
      status: "ok",
      buckets: [
        {
          windows: [
            { usedPercent: 42.5, resetsAt: "2026-10-20T00:00:00.000Z" },
          ],
        },
      ],
    });
    expect(parseGrokUsageResponse(zeroUsageResponse(), new Date(at))).toEqual({
      usedPercent: 0,
      resetsAt: "2026-10-20T00:00:00.000Z",
    });
  });

  it("reads only a bearer key from the supported auth store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grok-api-"));
    const path = join(dir, "auth.json");
    try {
      await writeFile(
        path,
        JSON.stringify({
          "https://auth.x.ai::client": {
            key: "grok-token",
            expires_at: "2099-01-01T00:00:00.000Z",
            email: "private@example.invalid",
          },
        }),
      );
      expect(await readGrokAccessToken(path)).toBe("grok-token");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses the fixed endpoint and never returns the token or raw response", async () => {
    const fetcher = vi.fn(async () => binaryResponse());
    const value = await fetchGrokUsage({
      capturedAt: at,
      accessToken: "synthetic-token",
      fetch: fetcher,
    });
    expect(value).toEqual(
      normalizeGrokUsage(parseGrokUsageResponse(response(), new Date()), at),
    );
    expect(fetcher).toHaveBeenCalledWith(
      GROK_USAGE_ENDPOINT,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: new Uint8Array([0, 0, 0, 0, 0]),
        headers: expect.objectContaining({
          Authorization: "Bearer synthetic-token",
          Referer: "https://grok.com/?_s=usage",
          "Content-Type": "application/grpc-web+proto",
        }),
      }),
    );
    expect(JSON.stringify(value)).not.toContain("synthetic-token");
  });

  it.each([
    [401, "auth", "error"],
    [403, "auth", "error"],
    [404, "unsupported", "unsupported"],
    [429, "rate_limited", "error"],
    [500, "network", "error"],
  ] as const)(
    "maps HTTP %s without preserving a response body",
    async (status, errorCode, state) => {
      const value = await fetchGrokUsage({
        capturedAt: at,
        accessToken: "synthetic-token",
        fetch: async () => new Response("secret-response", { status }),
      });
      expect(value).toMatchObject({ status: state, errorCode, buckets: [] });
      expect(JSON.stringify(value)).not.toMatch(
        /secret-response|synthetic-token/,
      );
    },
  );

  it("classifies missing credentials and stalled requests", async () => {
    const fetcher = vi.fn();
    expect(
      await fetchGrokUsage({
        capturedAt: at,
        credentialsPath: "/tmp/does-not-exist-grok-auth.json",
        fetch: fetcher,
      }),
    ).toMatchObject({ status: "unconfigured", errorCode: "unconfigured" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      fetchGrokUsage({
        capturedAt: at,
        accessToken: "synthetic-token",
        timeoutMs: 5,
        fetch: () => new Promise<Response>(() => {}),
      }),
    ).resolves.toMatchObject({ status: "error", errorCode: "timeout" });
  });
});
