import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import {
  emptyCommon,
  emptyUsage,
  usageSchema,
  type Common,
  type Usage,
} from "../../packages/contracts/src/index";
import { finitePercent, record } from "../claude/extract";
import { isoInstant } from "../shared/input";

/**
 * Hermes has no stable public Nous balance JSON endpoint. Its provider-usage
 * plugin reads the same fresh portal account helper used by `/usage` and then
 * calls `build_nous_credits_snapshot`. Keep that bridge deliberately small:
 * Python emits only already-selected numeric fields, never the account object.
 */
const HERMES_SCRIPT = String.raw`
import json
import math
import os
import sys

# Hermes keeps a few runtime modules (for example the pm module) in the checkout
# rather than the virtualenv's site-packages.  Make the shared checkout
# explicit so this bridge behaves the same way when launched by systemd.
sys.path.insert(0, os.environ.get("FIRE_HERMES_AGENT_ROOT") or os.path.expanduser("~/.hermes/hermes-agent"))

def finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) and value >= 0 else None

def instant(value):
    if value is None:
        return None
    try:
        if hasattr(value, "astimezone"):
            from datetime import timezone
            return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        return value if isinstance(value, str) else None
    except Exception:
        return None

def main():
    from hermes_cli.auth import get_provider_auth_state
    state = get_provider_auth_state("nous") or {}
    token = state.get("access_token")
    if not isinstance(token, str) or not token.strip():
        print(json.dumps({"available": False, "reason": "unconfigured"}))
        return

    from agent.account_usage import build_nous_credits_snapshot
    from hermes_cli.nous_account import get_nous_portal_account_info
    import threading
    result = {}
    errors = []
    def fetch_account():
        try:
            result["account"] = get_nous_portal_account_info(force_fresh=True)
        except BaseException as exc:
            errors.append(exc)
    thread = threading.Thread(target=fetch_account, daemon=True)
    thread.start()
    thread.join(10.0)
    if thread.is_alive():
        raise TimeoutError("Nous portal timeout")
    if errors:
        raise errors[0]
    account = result.get("account")
    snapshot = build_nous_credits_snapshot(account)
    if snapshot is None or not snapshot.available:
        print(json.dumps({"available": False, "reason": "missing"}))
        return

    access = getattr(account, "paid_service_access_info", None)
    subscription = getattr(account, "subscription", None)
    balance = {
        "subscription_remaining": finite(getattr(access, "subscription_credits_remaining", None)),
        "purchased_remaining": finite(getattr(access, "purchased_credits_remaining", None)),
        "total_remaining": finite(getattr(access, "total_usable_credits", None)),
        "monthly_allowance": finite(getattr(subscription, "monthly_credits", None)),
        "renews_at": instant(getattr(subscription, "current_period_end", None)),
    }
    windows = []
    for window in getattr(snapshot, "windows", ()) or ():
        used = finite(getattr(window, "used_percent", None))
        if used is None:
            continue
        windows.append({
            "label": "Subscription",
            "used_percent": used,
            "reset_at": instant(getattr(window, "reset_at", None)),
        })
    print(json.dumps({"available": True, "balance": balance, "windows": windows}))

main()
`;

export const DEFAULT_HERMES_PYTHON = `${homedir()}/.hermes/hermes-agent/venv/bin/python`;
export const DEFAULT_HERMES_HOME = `${homedir()}/.hermes`;
export const DEFAULT_HERMES_AGENT_ROOT = `${DEFAULT_HERMES_HOME}/hermes-agent`;

function failure(
  capturedAt: string,
  errorCode: NonNullable<Common["errorCode"]>,
  status: Common["status"] = "error",
): Usage {
  return usageSchema.parse({
    ...emptyUsage("hermes_nous"),
    ...emptyCommon(status),
    capturedAt,
    errorCode,
  });
}

function nonnegative(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

export function normalizeHermesNousApi(
  raw: unknown,
  capturedAt: string,
): Usage {
  const root = record(raw);
  const reason = root.reason;
  if (root.available !== true) {
    if (reason === "unconfigured")
      return failure(capturedAt, "unconfigured", "unconfigured");
    if (reason === "missing") return failure(capturedAt, "missing", "missing");
    return failure(capturedAt, "invalid_data");
  }

  const rawBalance = record(root.balance);
  const balanceValues = {
    subscriptionRemaining: nonnegative(rawBalance.subscription_remaining),
    purchasedRemaining: nonnegative(rawBalance.purchased_remaining),
    totalRemaining: nonnegative(rawBalance.total_remaining),
    monthlyAllowance: nonnegative(rawBalance.monthly_allowance),
    renewsAt: isoInstant(rawBalance.renews_at),
  };
  const hasBalance = Object.values(balanceValues).some(
    (value) => value !== null,
  );
  const rawWindows = Array.isArray(root.windows) ? root.windows : [];
  const windows = rawWindows.slice(0, 16).flatMap((item, index) => {
    const value = record(item);
    const usedPercent = finitePercent(value.used_percent);
    const label =
      typeof value.label === "string" && value.label.length <= 2048
        ? value.label
        : "Subscription";
    if (usedPercent === null && value.reset_at === undefined) return [];
    return [
      {
        id: `subscription-${index}`,
        label,
        usedPercent,
        windowMinutes: null,
        resetsAt: isoInstant(value.reset_at),
      },
    ];
  });
  if (!hasBalance && !windows.length)
    return failure(capturedAt, "invalid_data");

  return usageSchema.parse({
    ...emptyUsage("hermes_nous"),
    ...emptyCommon("ok"),
    capturedAt,
    sourceObservedAt: null,
    ...(hasBalance ? { balance: { currency: "USD", ...balanceValues } } : {}),
    buckets: windows.length
      ? [{ id: "subscription", label: "サブスクリプション", windows }]
      : [],
  });
}

type Runner = (pythonPath: string, timeoutMs: number) => Promise<unknown>;

function runHermesPython(
  pythonPath: string,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const agentRoot =
      process.env.FIRE_HERMES_AGENT_ROOT ??
      dirname(dirname(dirname(resolvePath(pythonPath))));
    const hermesHome = process.env.FIRE_HERMES_HOME ?? DEFAULT_HERMES_HOME;
    const child = spawn(pythonPath, ["-c", HERMES_SCRIPT], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
      cwd: agentRoot,
      env: {
        ...process.env,
        HERMES_HOME: hermesHome,
        FIRE_HERMES_AGENT_ROOT: agentRoot,
      },
    });
    let output = "";
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(Error("timeout"));
    }, timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(Error("invalid_data"));
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > 64 * 1024) {
        child.kill("SIGKILL");
        finish(Error("too_large"));
        return;
      }
      output += chunk.toString("utf8");
    });
    child.on("error", () => finish(Error("unconfigured")));
    child.on("close", (code) => {
      if (code !== 0) finish(Error("network"));
      else finish();
    });
  });
}

export type HermesNousApiOptions = {
  capturedAt: string;
  pythonPath?: string;
  timeoutMs?: number;
  run?: Runner;
};

export async function fetchHermesNousUsage(
  options: HermesNousApiOptions,
): Promise<Usage> {
  const timeoutMs = options.timeoutMs ?? 12000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    return failure(options.capturedAt, "unconfigured", "unconfigured");
  try {
    const raw = await (options.run ?? runHermesPython)(
      options.pythonPath ?? DEFAULT_HERMES_PYTHON,
      timeoutMs,
    );
    return normalizeHermesNousApi(raw, options.capturedAt);
  } catch (error) {
    const code = error instanceof Error ? error.message : "network";
    if (code === "timeout") return failure(options.capturedAt, "timeout");
    if (code === "too_large") return failure(options.capturedAt, "too_large");
    if (code === "unconfigured")
      return failure(options.capturedAt, "unconfigured", "unconfigured");
    if (code === "invalid_data")
      return failure(options.capturedAt, "invalid_data");
    return failure(options.capturedAt, "network");
  }
}
