import { z } from "zod";
import { providerSchema } from "../../../packages/usage-contracts/src/index";
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
export const usageConfigSchema = z.object({
  mqtt: z
    .object({
      enabled: z.boolean().default(false),
      url: z
        .string()
        .url()
        .refine(loopbackMqttUrl)
        .default("mqtt://127.0.0.1:1883"),
      topicPrefix: z.string().min(1).max(200).default("ai-usage/v1/main"),
      maxPayloadBytes: z.number().int().positive().max(8 * 1024 * 1024).default(2 * 1024 * 1024),
      credentialsFile: z.string().min(1).max(4096).optional(),
    })
    .default({
      enabled: false,
      url: "mqtt://127.0.0.1:1883",
      topicPrefix: "ai-usage/v1/main",
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
  preferredSources: z.partialRecord(providerSchema, sources).default({}),
});
export type UsageConfig = z.infer<typeof usageConfigSchema>;
export function resolveUsageEnvironment(env: NodeJS.ProcessEnv) {
  if (Object.keys(env).some(key => key.startsWith("FIRE_") && env[key])) throw Error("legacy_environment");
  const raw = env.USAGE_PORT ?? "8788";
  if (!/^[0-9]{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) throw Error("invalid_port");
  return { port: Number(raw), stateFile: env.USAGE_STATE_FILE ?? ".runtime/usage-state.json", configFile: env.USAGE_CONFIG ?? "services/usage/config.example.json", authModule: env.USAGE_AUTH_MODULE, origin: env.USAGE_PUBLIC_ORIGIN };
}
