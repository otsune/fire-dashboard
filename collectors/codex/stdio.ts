import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { normalizeCodex } from "./adapter";
import { emptyUsage, type Usage } from "../../packages/contracts/src/index";
type RpcRequest = { method: string; id?: number; params?: unknown };
export type RpcTransport = {
  send: (value: RpcRequest) => void;
  listen: (
    callback: (value: unknown) => void,
    onDisconnect?: () => void,
  ) => () => void;
  close: () => void;
};
function transport(): RpcTransport {
  const child = spawn("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "ignore"],
    shell: false,
  });
  const lines = createInterface({ input: child.stdout });
  let size = 0;
  child.stdout.on("data", (chunk) => {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) child.kill();
  });
  return {
    send: (value) => {
      child.stdin.write(JSON.stringify(value) + "\n");
    },
    listen: (cb, disconnect) => {
      const line = (value: string) => {
        try {
          cb(JSON.parse(value));
        } catch {
          disconnect?.();
        }
      };
      lines.on("line", line);
      child.on("error", () => disconnect?.());
      child.on("exit", () => disconnect?.());
      return () => lines.off("line", line);
    },
    close: () => {
      lines.close();
      child.kill();
    },
  };
}
export async function readLimitsWithTransport(
  connection: RpcTransport,
  capturedAt: string,
  timeoutMs = 10000,
): Promise<Usage> {
  return new Promise((resolve) => {
    let finished = false;
    let off = () => {};
    const fail = (code: Usage["errorCode"]) => ({
      ...emptyUsage("codex"),
      status:
        code === "unsupported" ? ("unsupported" as const) : ("error" as const),
      errorCode: code,
      capturedAt,
    });
    const finish = (value: Usage) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      off();
      connection.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(fail("timeout")), timeoutMs);
    off = connection.listen(
      (unknown) => {
        if (!unknown || typeof unknown !== "object") return;
        const value = unknown as {
          id?: number;
          result?: unknown;
          error?: { code?: number };
        };
        if (value.id !== 0 && value.id !== 1) return;
        if (value.error) {
          finish(
            fail(
              value.error.code === 401 || value.error.code === 403
                ? "auth"
                : value.error.code === -32601
                  ? "unsupported"
                  : "invalid_data",
            ),
          );
          return;
        }
        if (value.id === 0) {
          connection.send({ method: "initialized", params: {} });
          connection.send({ method: "account/rateLimits/read", id: 1 });
        } else {
          try {
            finish(normalizeCodex(value.result, capturedAt));
          } catch {
            finish(fail("invalid_data"));
          }
        }
      },
      () => finish(fail("network")),
    );
    try {
      connection.send({
        method: "initialize",
        id: 0,
        params: {
          clientInfo: {
            name: "fire_dashboard_readonly",
            title: "Fire Dashboard",
            version: "0.1.0",
          },
        },
      });
    } catch {
      finish(fail("network"));
    }
  });
}
export async function readCodexLimits(): Promise<Usage> {
  return readLimitsWithTransport(transport(), new Date().toISOString());
}
