import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { registerMqttGateway } from "../../../usage/src/mqtt/gateway";
import { validateUsageBaseUrl } from "./client";

export function registerUsageRelay(
  app: FastifyInstance,
  options: {
    baseUrl: string;
    readerToken: string;
    origin: string;
    maxPayloadBytes?: number;
    maxConnections?: number;
  },
) {
  const url = new URL(
    "/api/v1/usage/stream",
    validateUsageBaseUrl(options.baseUrl),
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  registerMqttGateway(app, {
    url: url.href,
    allowedOrigins: [options.origin],
    maxPayloadBytes: options.maxPayloadBytes,
    maxConnections: options.maxConnections,
    upstreamFactory: (target, protocol, wsOptions) =>
      new WebSocket(target, protocol, {
        ...wsOptions,
        headers: {
          authorization: `Bearer ${options.readerToken}`,
          origin: options.origin,
        },
        followRedirects: false,
      }),
  });
}
