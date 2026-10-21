import { readFile } from "node:fs/promises";
import { createTailscaleAuth } from "./auth-tailscale";
if (!process.env.USAGE_COLLECTOR_TOKENS_FILE)
  throw Error("authorization_required");
const auth = createTailscaleAuth({
  readerLogins: (process.env.USAGE_READER_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  collectorTokenHashes: JSON.parse(
    await readFile(process.env.USAGE_COLLECTOR_TOKENS_FILE, "utf8"),
  ),
  readerTokenHashes: process.env.USAGE_READER_TOKENS_FILE
    ? JSON.parse(await readFile(process.env.USAGE_READER_TOKENS_FILE, "utf8"))
    : [],
});
export const authorize = auth.authorize;
export const sourceAlias = auth.sourceAlias;
