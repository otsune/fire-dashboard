import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Authorize, AuthorizeAdmin, SourceAlias } from "./auth";
/**
 * For an API reached only through `tailscale serve` on a tailnet-only port.
 * Readers: the Tailscale-User-Login header that serve sets for tailnet users.
 * Collectors: a per-PC bearer token; the server stores only its SHA-256 hash
 * and derives the source alias from it, never from the request body.
 * Tailnet devices of one user share a login, so the login cannot tell a
 * tablet from a PC; that is why collectors need their own secret.
 */
export function createTailscaleAuth(options: {
  readerLogins: readonly string[];
  adminLogins?: readonly string[];
  collectorTokenHashes: Readonly<Record<string, string>>;
}): {
  authorize: Authorize;
  authorizeAdmin: AuthorizeAdmin;
  sourceAlias: SourceAlias;
} {
  const readers = new Set(options.readerLogins);
  const admins = new Set(options.adminLogins ?? []);
  const hashes = Object.entries(options.collectorTokenHashes).map(
    ([alias, hex]) => {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(alias) || !/^[0-9a-f]{64}$/.test(hex))
        throw Error("invalid_collector_token");
      return [alias, Buffer.from(hex, "hex")] as const;
    },
  );
  if (!readers.size || !hashes.length) throw Error("authorization_required");
  const collector = (request: FastifyRequest): string | null => {
    const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(
      request.headers.authorization ?? "",
    );
    if (!match) return null;
    const digest = createHash("sha256").update(match[1]).digest();
    let found: string | null = null;
    // Compare against every entry so timing does not reveal which alias matched.
    for (const [alias, hash] of hashes)
      if (timingSafeEqual(digest, hash) && !found) found = alias;
    return found;
  };
  const header = (request: FastifyRequest, name: string) => {
    const value = request.headers[name];
    return typeof value === "string" ? value : null;
  };
  return {
    authorize: async (request, role) =>
      role === "collector"
        ? collector(request) !== null
        : !request.headers.authorization &&
          readers.has(header(request, "tailscale-user-login") ?? ""),
    sourceAlias: async (request) => collector(request),
    authorizeAdmin: async (request) => {
      const login = header(request, "tailscale-user-login") ?? "";
      return (
        request.headers.authorization === undefined &&
        readers.has(login) &&
        admins.has(login)
      );
    },
  };
}
