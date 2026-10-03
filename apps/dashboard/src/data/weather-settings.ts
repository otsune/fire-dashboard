import {
  weatherSettingsViewSchema,
  weatherOfficesSchema,
  weatherOfficeSchema,
  weatherSaveResultSchema,
  weatherSettingsStateSchema,
  type WeatherSettingsState,
} from "../../../../packages/contracts/src/index";
import type { ZodType } from "zod";

const limit = 512 * 1024;
export class WeatherSettingsError extends Error {
  constructor(
    public code: string,
    public uncertain = false,
  ) {
    super(code);
  }
}
async function boundedText(response: Response): Promise<string> {
  if (Number(response.headers.get("Content-Length")) > limit)
    throw new WeatherSettingsError("too_large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0,
    text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new WeatherSettingsError("too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
async function request<T>(
  url: string,
  schema: ZodType<T>,
  signal?: AbortSignal,
  state?: WeatherSettingsState,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 10000);
  try {
    const response = await fetch(url, {
      method: state ? "PUT" : "GET",
      signal: controller.signal,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(state ? { "Content-Type": "application/json" } : {}),
      },
      ...(state ? { body: JSON.stringify(state) } : {}),
    });
    if (!response.ok) {
      const codes: Record<number, string> = {
        400: "invalid_data",
        401: "authentication_required",
        403: "forbidden",
        409: "revision_conflict",
        503: "service_unavailable",
      };
      throw new WeatherSettingsError(
        codes[response.status] ?? "network",
        !!state && ![400, 401, 403, 409, 503].includes(response.status),
      );
    }
    const text = await boundedText(response);
    try {
      return schema.parse(JSON.parse(text));
    } catch {
      throw new WeatherSettingsError("invalid_data", !!state);
    }
  } catch (error) {
    if (error instanceof WeatherSettingsError) {
      if (state && error.code === "too_large") error.uncertain = true;
      throw error;
    }
    throw new WeatherSettingsError(
      timedOut ? "timeout" : controller.signal.aborted ? "aborted" : "network",
      !!state,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
export const fetchWeatherSettings = (signal: AbortSignal) =>
  request("/api/v1/weather-settings", weatherSettingsViewSchema, signal);
export const fetchWeatherOffices = (signal: AbortSignal) =>
  request("/api/v1/weather-catalog", weatherOfficesSchema, signal);
export function fetchWeatherOffice(office: string, signal: AbortSignal) {
  if (!/^\d{6}$/.test(office))
    return Promise.reject(new WeatherSettingsError("invalid_data"));
  return request(
    `/api/v1/weather-catalog?office=${encodeURIComponent(office)}`,
    weatherOfficeSchema,
    signal,
  );
}
export function saveWeatherSettings(state: WeatherSettingsState) {
  const valid = weatherSettingsStateSchema.safeParse(state);
  if (!valid.success)
    return Promise.reject(new WeatherSettingsError("invalid_data"));
  // No caller cancellation: once submitted, the write may already be committed.
  return request(
    "/api/v1/weather-settings",
    weatherSaveResultSchema,
    undefined,
    valid.data,
  );
}
