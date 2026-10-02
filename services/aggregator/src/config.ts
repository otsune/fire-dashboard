import { z } from "zod";
import { providerSchema } from "../../../packages/contracts/src/index";
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
  preferredSources: z
    .partialRecord(
      providerSchema,
      z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-zA-Z0-9_-]+$/),
    )
    .default({}),
});
export type Config = z.infer<typeof configSchema>;
