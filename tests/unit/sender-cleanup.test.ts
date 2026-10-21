import { afterEach, expect, it, vi } from "vitest";
import { createHttpSender } from "../../collectors/shared/sender";
import { usageEnvelope } from "../helpers/usage";
afterEach(() => vi.unstubAllGlobals());
it.each([200, 401, 503])(
  "releases the response body after HTTP %s",
  async (status) => {
    let released = false;
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            cancel: () => {
              released = true;
            },
          }),
          { status },
        ),
    );
    const send = createHttpSender(
      new URL("https://usage.example/api/v1/usage"),
      async () => ({ authorization: "Bearer test-only" }),
    );
    if (status === 200) await send(usageEnvelope(1));
    else
      await expect(send(usageEnvelope(1))).rejects.toThrow(
        status === 401 ? "auth" : "network",
      );
    expect(released).toBe(true);
  },
);
