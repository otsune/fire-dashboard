import { readFile } from "node:fs/promises";
import {
  envelopeSchema,
  type UsageEnvelope,
} from "../../packages/contracts/src/index";
/**
 * Bearer header from a token file. The token never comes from the process
 * environment or unit files, and is re-read on each send to allow rotation.
 */
export function bearerFromFile(tokenFile: string) {
  return async (): Promise<Record<string, string>> => {
    const token = (await readFile(tokenFile, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw Error("invalid_token");
    return { authorization: `Bearer ${token}` };
  };
}
export function createSender(send: (envelope: UsageEnvelope) => Promise<void>) {
  let lastId: string | null = null,
    lastAt = -Infinity,
    pending: Promise<void> | null = null;
  return async (envelope: UsageEnvelope, now = Date.now()): Promise<void> => {
    if (pending) await pending;
    if (lastId === envelope.snapshotId && now - lastAt < 60000) return;
    pending = send(envelopeSchema.parse(envelope))
      .then(() => {
        lastId = envelope.snapshotId;
        lastAt = now;
      })
      .finally(() => {
        pending = null;
      });
    await pending;
  };
}
export function createHttpSender(
  endpoint: URL,
  authorization: () => Promise<Record<string, string>>,
) {
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/api/v1/usage"
  )
    throw Error("secure_endpoint_required");
  return createSender(async (envelope) => {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        "content-type": "application/json",
        ...(await authorization()),
      },
      body: JSON.stringify(envelope),
    });
    if (!response.ok) throw Error(response.status === 401 ? "auth" : "network");
  });
}
