import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import {
  ResendSendError,
  ResendService,
} from "../src/notifications/resend.service.js";
import { RESEND_SEND_TIMEOUT_MS } from "../src/notifications/notifications.constants.js";

/**
 * `ResendService` is a thin `fetch` wrapper over Resend's REST API (design
 * "ResendService" section) — deliberately NOT the `resend` npm SDK, matching
 * how `MeiliService`/`SpotifyClient`/`MusicBrainzClient` already wrap their
 * upstreams. These tests stub the global `fetch`, so nothing here needs a live
 * Resend account or a network, and they pin the two behaviours the email
 * worker (Phase 12) will depend on:
 *
 * 1. **The no-op fallback is total.** With no API key the service must return
 *    `{ status: "skipped" }` WITHOUT calling `fetch` and WITHOUT throwing —
 *    throwing would burn all three BullMQ attempts and dump every dev
 *    notification into the failed set.
 * 2. **`html` is opaque.** HTML-escaping is the worker's job at composition
 *    time (that is where the raw field values live), so this service must pass
 *    the string through byte-for-byte. A test here asserting escaped output
 *    would enshrine the escaping in the wrong layer.
 */

const RESEND_URL = "https://api.resend.com/emails";

interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal | null | undefined;
}

function config(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

/** Fully configured client — the "enabled" path. */
function enabledConfig(): ConfigService {
  return config({
    RESEND_API_KEY: "re_test_key",
    RESEND_FROM_EMAIL: "Coda <notifications@coda.test>",
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Same shape as {@link jsonResponse}, but `.json()` rejects instead of
 * resolving — simulates the abort firing while the body is being read. */
function abortingJsonResponse(err: Error): Response {
  return {
    ok: true,
    status: 200,
    json: async () => {
      throw err;
    },
    text: async () => "",
  } as unknown as Response;
}

/** Same idea as {@link abortingJsonResponse}, but for the non-OK path: a
 * non-2xx status whose error-body `.text()` read rejects instead of
 * resolving — simulates the abort firing while the error body is stalled. */
function abortingTextResponse(status: number, err: Error): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => {
      throw err;
    },
  } as unknown as Response;
}

function stubFetch(
  calls: FakeCall[],
  responder: () => Response = () => jsonResponse(200, { id: "email-1" }),
) {
  const fetchMock = vi.fn(
    async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({
        url,
        method: init.method ?? "GET",
        headers: (init.headers as Record<string, string>) ?? {},
        body: JSON.parse(init.body as string) as Record<string, unknown>,
        signal: init.signal,
      });
      return responder();
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const email = {
  to: "recipient@coda.test",
  subject: "alice started following you",
  html: "<p>Hello</p>",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ResendService", () => {
  let calls: FakeCall[];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    calls = [];
    warnSpy = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
  });

  it("does no network I/O at construction (lazy infra)", () => {
    const fetchMock = stubFetch(calls);

    new ResendService(enabledConfig());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips the send when RESEND_API_KEY is unset: no fetch, no throw", async () => {
    const fetchMock = stubFetch(calls);
    const service = new ResendService(
      config({ RESEND_FROM_EMAIL: "Coda <notifications@coda.test>" }),
    );

    const result = await service.send(email);

    expect(result).toEqual({ status: "skipped", reason: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("also skips when RESEND_FROM_EMAIL is unset — Resend rejects a send with no sender", async () => {
    const fetchMock = stubFetch(calls);
    const service = new ResendService(config({ RESEND_API_KEY: "re_test_key" }));

    const result = await service.send(email);

    expect(result).toEqual({ status: "skipped", reason: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("warns exactly once at construction when disabled, naming the missing variable", () => {
    stubFetch(calls);

    new ResendService(config({}));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("RESEND_API_KEY"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("RESEND_FROM_EMAIL"),
    );
  });

  it("does not warn at construction when fully configured", () => {
    stubFetch(calls);

    new ResendService(enabledConfig());

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("POSTs the email to Resend with the bearer key, JSON content type and configured sender", async () => {
    stubFetch(calls);
    const service = new ResendService(enabledConfig());

    const result = await service.send(email);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(RESEND_URL);
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe("Bearer re_test_key");
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(call.body).toEqual({
      from: "Coda <notifications@coda.test>",
      to: "recipient@coda.test",
      subject: "alice started following you",
      html: "<p>Hello</p>",
    });
    expect(result).toEqual({ status: "sent", id: "email-1" });
  });

  it("wires an AbortSignal to the fetch that is actually tied to RESEND_SEND_TIMEOUT_MS, not just any signal", async () => {
    // `AbortSignal.timeout()`'s abort fires from Node's internal timer
    // machinery, which `vi.useFakeTimers()` cannot intercept — so instead of
    // trying to fast-forward a real abort, assert on the one thing that
    // actually distinguishes "tied to RESEND_SEND_TIMEOUT_MS" from "any
    // signal": the exact millisecond value passed to `AbortSignal.timeout`,
    // and that its returned signal is the very one handed to `fetch`.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    stubFetch(calls);
    const service = new ResendService(enabledConfig());

    await service.send(email);

    expect(timeoutSpy).toHaveBeenCalledWith(RESEND_SEND_TIMEOUT_MS);
    expect(calls[0]!.signal).toBe(timeoutSpy.mock.results[0]?.value);
  });

  it("rethrows a genuine timeout that fires during the body read instead of treating it as a successful send", async () => {
    // `AbortSignal.timeout()` rejects with a `DOMException` named
    // `"TimeoutError"` (confirmed against this repo's Node version) — never
    // `"AbortError"`, which is what a manually-triggered `AbortController`
    // would produce. The source keeps an `"AbortError"` check too for
    // forward-compat, but the test must exercise the branch Node actually
    // hits in production, or a narrowing of that check to just
    // `"AbortError"` would keep this test green while silently
    // reintroducing the fake-success regression.
    const timeoutError = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
    stubFetch(calls, () => abortingJsonResponse(timeoutError));
    const service = new ResendService(enabledConfig());

    const error = await service.send(email).catch((err: unknown) => err);

    expect(error).toBe(timeoutError);
  });

  it("warns when a 2xx response has no `id` in the body, but still reports success", async () => {
    stubFetch(calls, () => jsonResponse(200, {}));
    const service = new ResendService(enabledConfig());

    const result = await service.send(email);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no `id`"));
    expect(result).toEqual({ status: "sent", id: "" });
  });

  it("passes `html` through opaquely — escaping belongs to the worker, not here", async () => {
    stubFetch(calls);
    const service = new ResendService(enabledConfig());
    // Deliberately hostile: metacharacters that a service which "helpfully"
    // escaped or sanitised would mangle. The worker escapes at composition
    // time; by the time the string reaches here it is finished HTML.
    const html = `<p>a &amp; b &lt;script&gt; "quoted" 'single'</p>`;

    await service.send({ ...email, html });

    expect(calls[0]!.body.html).toBe(html);
  });

  it("throws a ResendSendError carrying the HTTP status on a 4xx response", async () => {
    stubFetch(calls, () =>
      jsonResponse(422, { message: "Invalid `to` field" }),
    );
    const service = new ResendService(enabledConfig());

    const error = await service.send(email).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ResendSendError);
    expect((error as ResendSendError).status).toBe(422);
    expect((error as ResendSendError).message).toContain("Invalid `to` field");
  });

  it("rethrows a genuine timeout that fires while reading a non-OK response's error body, instead of an empty-detail ResendSendError", async () => {
    // Same bug class as the success-path body-read timeout: `AbortSignal
    // .timeout()` governs the error body read too, so an abort firing while
    // `.text()` is pending on a non-OK response must propagate as the real
    // timeout — not be swallowed by the `.catch(() => "")` into a
    // `ResendSendError` with an empty detail, which would hide that this was
    // actually a timeout rather than a genuine 4xx/5xx from Resend.
    const timeoutError = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
    stubFetch(calls, () => abortingTextResponse(500, timeoutError));
    const service = new ResendService(enabledConfig());

    const error = await service.send(email).catch((err: unknown) => err);

    expect(error).toBe(timeoutError);
  });

  it("throws a ResendSendError carrying the HTTP status on a 5xx response", async () => {
    // Triangulates the status: the worker classifies 4xx-not-429 as
    // UnrecoverableError and 429/5xx as retryable (design Decision 10), so the
    // status must be the REAL one, not a constant.
    stubFetch(calls, () => jsonResponse(503, { message: "upstream down" }));
    const service = new ResendService(enabledConfig());

    const error = await service.send(email).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ResendSendError);
    expect((error as ResendSendError).status).toBe(503);
  });
});
