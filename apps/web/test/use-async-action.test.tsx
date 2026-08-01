// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useAsyncAction } from "../lib/use-async-action";

afterEach(() => {
  cleanup();
});

/** A promise the test settles by hand, plus its resolve/reject handles. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The rejection handle is only attached when a test actually rejects, so an
  // unused deferred never trips an unhandled-rejection warning.
  return { promise, resolve, reject };
}

describe("useAsyncAction", () => {
  it("starts idle, with nothing to disable and nothing to announce", () => {
    const { result } = renderHook(() => useAsyncAction());

    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.running.current).toBe(false);
  });

  it("stays busy for the whole action and releases once it resolves", async () => {
    const action = deferred();
    const { result } = renderHook(() => useAsyncAction());

    let settled!: Promise<void>;
    await act(async () => {
      settled = result.current.run(() => action.promise);
    });

    // `busy` is what drives the `disabled` attribute on every caller.
    expect(result.current.busy).toBe(true);

    await act(async () => {
      action.resolve();
      await settled;
    });

    expect(result.current.busy).toBe(false);
    expect(result.current.running.current).toBe(false);
  });

  it("closes the re-entrancy guard SYNCHRONOUSLY, before the first await", () => {
    const action = deferred();
    const { result } = renderHook(() => useAsyncAction());

    act(() => {
      void result.current.run(() => action.promise);
      // A `busy` state update cannot be observed by a second handler firing in
      // the same tick, so the guard has to be a ref that is already closed by
      // the time `run` returns its promise.
      expect(result.current.running.current).toBe(true);
    });

    act(() => {
      action.resolve();
    });
  });

  it("ignores a second run while the first is still in flight", async () => {
    const action = deferred();
    const run = vi.fn(() => action.promise);
    const { result } = renderHook(() => useAsyncAction());

    await act(async () => {
      void result.current.run(run);
    });
    await act(async () => {
      void result.current.run(run);
    });

    expect(run).toHaveBeenCalledTimes(1);

    await act(async () => {
      action.resolve();
    });
  });

  it("surfaces the failure's own message and re-opens the control for a retry", async () => {
    const { result } = renderHook(() => useAsyncAction());

    await act(async () => {
      await result.current.run(() => {
        throw new Error("Could not like this list.");
      });
    });

    expect(result.current.error).toBe("Could not like this list.");
    // A failed mutation did not persist, so the viewer must be able to retry.
    expect(result.current.busy).toBe(false);
    expect(result.current.running.current).toBe(false);
  });

  it("falls back to a generic message for a non-Error rejection", async () => {
    const { result } = renderHook(() => useAsyncAction());

    await act(async () => {
      await result.current.run(() => Promise.reject("a bare string"));
    });

    expect(result.current.error).toBe("Something went wrong.");
  });

  it("clears the previous error when the next run starts", async () => {
    const { result } = renderHook(() => useAsyncAction());

    await act(async () => {
      await result.current.run(() => Promise.reject(new Error("First try.")));
    });
    expect(result.current.error).toBe("First try.");

    await act(async () => {
      await result.current.run(() => Promise.resolve());
    });

    // A stale banner outliving the state it described is exactly the bug the
    // list-like button had to fix on its own re-sync path.
    expect(result.current.error).toBeNull();
  });

  it("lets a caller set and clear the banner directly", () => {
    const { result } = renderHook(() => useAsyncAction());

    act(() => {
      result.current.setError("Stale.");
    });
    expect(result.current.error).toBe("Stale.");

    act(() => {
      result.current.setError(null);
    });
    expect(result.current.error).toBeNull();
  });

  it("hands onError the RAW failure, after the message is already stored", async () => {
    class Refused extends Error {
      constructor(readonly status: number) {
        super("Refused.");
      }
    }
    const seen: unknown[] = [];
    const { result } = renderHook(() => useAsyncAction());

    await act(async () => {
      await result.current.run(() => Promise.reject(new Refused(409)), {
        onError: (error) => {
          seen.push(error);
          // Callers reconcile on the error's TYPE and status, so the raw
          // value has to survive — not just its message.
          expect(error).toBeInstanceOf(Refused);
        },
      });
    });

    expect(seen).toHaveLength(1);
    expect(result.current.error).toBe("Refused.");
  });

  it("keeps the control latched after a success when asked to", async () => {
    const action = vi.fn(() => Promise.resolve());
    const { result } = renderHook(() => useAsyncAction());

    await act(async () => {
      await result.current.run(action, { latchOnSuccess: true });
    });

    // A delete whose row is about to be removed by a fire-and-forget
    // `router.refresh()` must NOT re-enable: a second click would land on a
    // record that no longer exists.
    expect(result.current.busy).toBe(true);
    expect(result.current.running.current).toBe(true);

    await act(async () => {
      await result.current.run(action);
    });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("lets onError latch the control by returning true", async () => {
    const { result } = renderHook(() => useAsyncAction());

    await act(async () => {
      await result.current.run(() => Promise.reject(new Error("Gone.")), {
        onError: () => true,
      });
    });

    // The server has confirmed the target is gone — that is not a transient
    // failure, so the control settles exactly as a latched success would.
    expect(result.current.error).toBe("Gone.");
    expect(result.current.busy).toBe(true);
    expect(result.current.running.current).toBe(true);
  });

  it("releases when onError returns nothing, so a transient failure is retryable", async () => {
    const { result } = renderHook(() => useAsyncAction());

    await act(async () => {
      await result.current.run(() => Promise.reject(new Error("Refused.")), {
        onError: () => {},
      });
    });

    expect(result.current.busy).toBe(false);
    expect(result.current.running.current).toBe(false);
  });

  it("still releases the guard when onError itself throws", async () => {
    const { result } = renderHook(() => useAsyncAction());

    await act(async () => {
      await result.current.run(() => Promise.reject(new Error("Refused.")), {
        onError: () => {
          throw new Error("onError blew up.");
        },
      });
    });

    // A caller's `onError` throwing (e.g. a state setter or `router.refresh()`
    // misbehaving) must not leave the control permanently disabled with no
    // path to retry — release is guaranteed the same way the pre-extraction
    // per-component `try/catch/finally` guaranteed it.
    expect(result.current.busy).toBe(false);
    expect(result.current.running.current).toBe(false);
  });

  it("logs the swallowed error when onError itself throws", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { result } = renderHook(() => useAsyncAction());
    const caught = new Error("Refused.");
    const onErrorFailure = new Error("onError blew up.");

    await act(async () => {
      await result.current.run(() => Promise.reject(caught), {
        onError: () => {
          throw onErrorFailure;
        },
      });
    });

    // A buggy `onError` (e.g. a call site's own invariant check throwing) must
    // leave a trace — silently vanishing makes "why didn't my rollback fire?"
    // undiagnosable for whoever wrote that call site's handler. Both the
    // original triggering failure and what `onError` threw are logged
    // together, since either one alone is missing half the story.
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.any(String), {
      caught,
      onErrorFailure,
    });
  });

  it("keeps `run` stable across renders so callers may depend on it", () => {
    const { result, rerender } = renderHook(() => useAsyncAction());
    const first = result.current.run;

    rerender();

    expect(result.current.run).toBe(first);
    expect(result.current.running).toBe(result.current.running);
  });
});
