import { z } from "zod";
import { weatherSchema } from "./index";

export const weatherSelectionSchema = z.strictObject({
  office: z.string().regex(/^\d{6}$/),
  region: z.string().regex(/^\d{6}$/),
  station: z.string().regex(/^\d{5,7}$/),
});
export const weatherSettingsStateSchema = z.strictObject({
  revision: z.string().min(1).max(128),
  selection: weatherSelectionSchema.nullable(),
});
export const weatherSettingsViewSchema = weatherSettingsStateSchema.extend({
  canEdit: z.boolean(),
  weather: z.lazy(() => weatherSchema),
});
export const namedWeatherAreaSchema = z.strictObject({
  id: z.string().regex(/^\d{5,7}$/),
  label: z.string().min(1).max(200),
});
export const weatherOfficesSchema = z.strictObject({
  offices: z.array(namedWeatherAreaSchema).max(200),
});
export const weatherOfficeSchema = z.strictObject({
  office: namedWeatherAreaSchema,
  regions: z.array(namedWeatherAreaSchema).max(1000),
  stations: z.array(namedWeatherAreaSchema).max(1000),
});
export const weatherSaveResultSchema = z.strictObject({
  settings: weatherSettingsStateSchema,
  weather: z.lazy(() => weatherSchema),
});
export type WeatherSelection = z.infer<typeof weatherSelectionSchema>;
export type WeatherSettingsState = z.infer<typeof weatherSettingsStateSchema>;
export type WeatherSettingsView = z.infer<typeof weatherSettingsViewSchema>;
export type NamedWeatherArea = z.infer<typeof namedWeatherAreaSchema>;
export type WeatherOffices = z.infer<typeof weatherOfficesSchema>;
export type WeatherOffice = z.infer<typeof weatherOfficeSchema>;
export type WeatherSaveResult = z.infer<typeof weatherSaveResultSchema>;
