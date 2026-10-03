// Usage: node scripts/new-collector-token.mjs <sourceAlias>
// Prints the token for the collector PC and the entry for the server's token file.
import { createHash, randomBytes } from "node:crypto";
const alias = process.argv[2];
if (!alias || !/^[a-zA-Z0-9_-]{1,64}$/.test(alias)) {
  process.stderr.write("usage: node scripts/new-collector-token.mjs <sourceAlias>\n");
  process.exit(1);
}
const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");
process.stdout.write(
  `collector PC (keep secret): ${token}\nserver token file entry: ${JSON.stringify({ [alias]: hash })}\n`,
);
