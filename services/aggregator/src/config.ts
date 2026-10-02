import { z } from "zod";
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
    .object({
      claude: z.string().max(64).optional(),
      codex: z.string().max(64).optional(),
    })
    .default({}),
});
export type Config = z.infer<typeof configSchema>;
