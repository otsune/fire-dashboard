import { z } from "zod";

export const MAX_INPUT_BYTES = 1024 * 1024;
const timestamp = z.string().datetime({ offset: true });

/** Require an actual timestamp and timezone; a date alone has no known instant. */
export function isoInstant(value: unknown): string | null {
  const parsed = timestamp.safeParse(value);
  if (!parsed.success) return null;
  const milliseconds = Date.parse(parsed.data);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}

/** Read once, bound bytes (including multibyte input), and never echo input errors. */
export async function readJsonInput(
  input: AsyncIterable<string | Uint8Array>,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_INPUT_BYTES) throw Error("too_large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Error("invalid_data");
  }
}
