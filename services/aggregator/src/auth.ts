import type { FastifyRequest } from "fastify";
export type Authorize = (
  request: FastifyRequest,
  role: "reader" | "collector",
) => Promise<boolean>;
export type SourceAlias = (request: FastifyRequest) => Promise<string | null>;
/** Integrate a separately approved same-origin session validator. Never accept roles/aliases from request bodies. */
export const denyAll: Authorize = async () => false;
