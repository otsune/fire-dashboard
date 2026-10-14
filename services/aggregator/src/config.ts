import { z } from "zod";
import { providerSchema } from "../../../packages/contracts/src/index";
const alias = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/);
const sources = z.union([alias, z.array(alias).min(1).max(16)]);
const loopbackMqttUrl = (value: string) => {
  const parsed = new URL(value);
  return (
    ["mqtt:", "mqtts:"].includes(parsed.protocol) &&
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)
  );
};
const loopbackWsUrl = (value: string) => {
  const parsed = new URL(value);
  return (
    ["ws:", "wss:"].includes(parsed.protocol) &&
    ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)
  );
};
export const configSchema = z.object({
  mqtt: z
    .object({
      enabled: z.boolean().default(false),
      url: z
        .string()
        .url()
        .refine(loopbackMqttUrl)
        .default("mqtt://127.0.0.1:1883"),
      topicPrefix: z.string().min(1).max(200).default("fire-dashboard/v1/main"),
      maxPayloadBytes: z.number().int().positive().max(8 * 1024 * 1024).default(2 * 1024 * 1024),
      credentialsFile: z.string().min(1).max(4096).optional(),
    })
    .default({
      enabled: false,
      url: "mqtt://127.0.0.1:1883",
      topicPrefix: "fire-dashboard/v1/main",
      maxPayloadBytes: 2 * 1024 * 1024,
    }),
  gateway: z
    .object({
      enabled: z.boolean().default(false),
      url: z
        .string()
        .url()
        .refine(loopbackWsUrl)
        .default("ws://127.0.0.1:9001/mqtt"),
      path: z.string().regex(/^\/[A-Za-z0-9_\/-]+$/).default("/api/v1/usage/stream"),
      maxPayloadBytes: z.number().int().positive().max(8 * 1024 * 1024).default(2 * 1024 * 1024),
      maxConnections: z.number().int().positive().max(256).default(8),
    })
    .default({
      enabled: false,
      url: "ws://127.0.0.1:9001/mqtt",
      path: "/api/v1/usage/stream",
      maxPayloadBytes: 2 * 1024 * 1024,
      maxConnections: 8,
    }),
  weather: z
    .object({
      office: z.string().regex(/^\d{6}$/),
      region: z.string().regex(/^\d{6}$/),
      station: z.string().regex(/^\d{5,7}$/),
    })
    .nullable()
    .default(null),
  feeds: z
    .array(
      z.object({
        id: z
          .string()
          .regex(/^[a-z0-9_-]+$/)
          .max(64),
        label: z.string().min(1).max(100),
        url: z.url().refine((v) => new URL(v).protocol === "https:"),
      }),
    )
    .max(32)
    .default([]),
  // One alias, or several PCs that report the same account-wide limits.
  preferredSources: z.partialRecord(providerSchema, sources).default({}),
});
export type Config = z.infer<typeof configSchema>;
/** Loopback port; FIRE_PORT lets the API coexist with other local services. */
export function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 8787;
  if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535)
    throw Error("invalid_port");
  return Number(value);
}
