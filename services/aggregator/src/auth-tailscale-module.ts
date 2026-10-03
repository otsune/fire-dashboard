/*
 * FIRE_AUTH_MODULE entry for a Tailscale serve deployment.
 * FIRE_READER_LOGINS: comma-separated Tailscale logins allowed to view.
 * FIRE_COLLECTOR_TOKENS_FILE: JSON {"<sourceAlias>": "<sha256 hex of token>"},
 * kept outside the repository and readable only by the service user.
 */
import { readFile } from "node:fs/promises";
import { createTailscaleAuth } from "./auth-tailscale";
const tokensFile = process.env.FIRE_COLLECTOR_TOKENS_FILE;
if (!tokensFile) throw Error("authorization_required");
const auth = createTailscaleAuth({
  readerLogins: (process.env.FIRE_READER_LOGINS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean),
  collectorTokenHashes: JSON.parse(await readFile(tokensFile, "utf8")),
});
export const authorize = auth.authorize;
export const sourceAlias = auth.sourceAlias;
