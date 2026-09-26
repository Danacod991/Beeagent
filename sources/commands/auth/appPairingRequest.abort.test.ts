// Offline tests for the retry loop's abort handling. These stub globalThis.fetch
// so they never touch the network and never create a real pairing request.
import { afterEach, describe, expect, it } from "bun:test";
import { requestAppPairing } from "./appPairingRequest";

const PENDING_BODY = {
  ok: true,
  status: "pending",
  requestId: "req-1",
  expiresAt: "2030-01-01T00:00:00Z",
};

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: () => Promise<Response>): { attempts: () => number } {
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    return await handler();
  }) as unknown as typeof fetch;
  return { attempts: () => attempts };
}

// Returns the rejection, or fails loudly if the call unexpectedly resolved.
async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("requestAppPairing abort handling", () => {
  it("does not send a request when the signal is already aborted", async () => {
    const stub = stubFetch(async () => jsonResponse(PENDING_BODY));
    const controller = new AbortController();
    controller.abort();

    await expect(
      requestAppPairing("staging", "app", "key", controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(stub.attempts()).toBe(0);
  });

  it("surfaces the abort rather than a misleading network error", async () => {
    stubFetch(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const controller = new AbortController();
    controller.abort();

    const error = await captureError(
      requestAppPairing("staging", "app", "key", controller.signal)
    );

    expect(error.name).toBe("AbortError");
    expect(error.name).not.toBe("NetworkError");
    // The old behaviour blamed the user's connection for their own cancellation.
    expect(error.message).not.toContain("check your internet connection");
  });

  it("stops promptly when the signal fires midway through the retry loop", async () => {
    // Without the fix this ran the full backoff schedule
    // (1+2+4+8+16+30+30+30+30 = 151s) after the abort.
    const controller = new AbortController();
    stubFetch(async () => {
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    const started = Date.now();
    await expect(
      requestAppPairing("staging", "app", "key", controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(Date.now() - started).toBeLessThan(2000);
  }, 15000);

  it("rethrows a timeout as a TimeoutError, not an AbortError", async () => {
    // AbortSignal.timeout() aborts with a TimeoutError, which is why the guard
    // inspects the signal instead of matching on the error name.
    const signal = AbortSignal.timeout(20);
    stubFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      throw new DOMException("The operation timed out.", "TimeoutError");
    });

    const error = await captureError(
      requestAppPairing("staging", "app", "key", signal)
    );

    expect(error.name).toBe("TimeoutError");
  }, 15000);

  it("still retries a genuine network error", async () => {
    // The fix must not disable normal resilience. Attempt 1 sleeps 1s and
    // attempt 2 sleeps 2s, hence the generous timeout.
    let attempt = 0;
    const stub = stubFetch(async () => {
      attempt += 1;
      if (attempt <= 2) {
        throw new TypeError("fetch failed");
      }
      return jsonResponse(PENDING_BODY);
    });

    const result = await requestAppPairing("staging", "app", "key");

    expect(result).toEqual({
      status: "pending",
      requestId: "req-1",
      expiresAt: "2030-01-01T00:00:00Z",
    });
    expect(stub.attempts()).toBe(3);
  }, 20000);

  it("still retries a 5xx response", async () => {
    let attempt = 0;
    stubFetch(async () => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse({ error: "boom" }, 503)
        : jsonResponse(PENDING_BODY);
    });

    const result = await requestAppPairing("staging", "app", "key");

    expect(result.status).toBe("pending");
    expect(attempt).toBe(2);
  }, 15000);

  it("works unchanged when no signal is supplied", async () => {
    const stub = stubFetch(async () => jsonResponse(PENDING_BODY));

    const result = await requestAppPairing("staging", "app", "key");

    expect(result.status).toBe("pending");
    expect(stub.attempts()).toBe(1);
  });
});
