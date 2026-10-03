import { z } from "zod";
import { providerSchema } from "../../../packages/contracts/src/index";
const alias = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/);
const sources = z.union([alias, z.array(alias).min(1).max(16)]);
export const configSchema = z.object({
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
