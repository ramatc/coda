"use client";

import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

/** What a caller shows when the failure carries no message of its own. */
const FALLBACK_ERROR_MESSAGE = "Something went wrong.";

/** Per-call adjustments to how {@link AsyncAction.run} settles. */
export interface RunOptions {
  /**
   * Failure hook, invoked AFTER the message has been stored in
   * {@link AsyncAction.error} and given the RAW rejection value — callers
   * reconcile on the error's type and status, not on its message.
   *
   * This is where a caller rolls back its own optimistic update and decides
   * whether the failure means its picture of the world is stale enough to
   * warrant a `router.refresh()`.
   *
   * Return `true` to LATCH the control (see {@link RunOptions.latchOnSuccess}).
   * Anything else — including `undefined` — releases it, so a transient failure
   * is retryable.
   */
  onError?: (error: unknown) => boolean | void;
  /**
   * Keep the control latched after the action RESOLVES instead of releasing it:
   * `busy` stays true and the guard stays closed.
   *
   * For a delete whose row is about to be removed by a fire-and-forget
   * `router.refresh()`, releasing would reopen a window in which a second click
   * lands on a record that no longer exists.
   */
  latchOnSuccess?: boolean;
}

/** The busy/error surface {@link useAsyncAction} hands its caller. */
export interface AsyncAction {
  /** True while an action is running — every caller's `disabled` source. */
  busy: boolean;
  /** The last failure's message, rendered inline as a `role="alert"`. */
  error: string | null;
  /**
   * Direct access to the banner, for the states `run` cannot know about:
   * opening/closing an editor, or clearing a stale error once fresh server
   * props land.
   */
  setError: Dispatch<SetStateAction<string | null>>;
  /**
   * The synchronous re-entrancy guard behind {@link AsyncAction.busy}, exposed
   * so callers can read it in the two places a state value is no good:
   *
   * - BEFORE applying an optimistic update, so a rejected second click does not
   *   flip local state that no request will ever settle;
   * - inside a props re-sync effect, so a `router.refresh()` landing mid-flight
   *   never stomps a pending optimistic update.
   *
   * A ref rather than state on purpose: a `setBusy(true)` cannot be observed by
   * a second handler firing in the same tick.
   */
  running: RefObject<boolean>;
  /**
   * Runs `action` under the guard: bails if one is already in flight, marks the
   * control busy, clears the previous error, and settles per {@link RunOptions}.
   *
   * Deliberately does NOT own optimistic updates, rollback, reconciliation, or
   * `router.refresh()` — those differ per control, and folding them in here
   * would force five islands with genuinely different reconciliation rules to
   * converge on one.
   */
  run: (action: () => Promise<unknown>, options?: RunOptions) => Promise<void>;
}

/**
 * The busy/in-flight/error shape shared by every write island in the app
 * (`review-like-button`, `review-comment-form`, `review-comment-item`,
 * `list-like-button`, `follow-button`).
 *
 * What is shared is the PLUMBING: one request at a time, a `busy` flag driving
 * `disabled`, and a failure message to render inline. What is deliberately left
 * to each caller is the part that actually differs — the optimistic update and
 * its rollback, which statuses are worth reconciling, and whether the control
 * should re-enable at all once the action lands.
 */
export function useAsyncAction(): AsyncAction {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);

  const run = useCallback(
    async (action: () => Promise<unknown>, options: RunOptions = {}) => {
      if (running.current) {
        return;
      }

      running.current = true;
      setBusy(true);
      setError(null);

      try {
        await action();
        if (!options.latchOnSuccess) {
          running.current = false;
          setBusy(false);
        }
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : FALLBACK_ERROR_MESSAGE,
        );

        // `onError` runs in its OWN try/catch/finally so a caller whose
        // handler throws (e.g. a state setter or `router.refresh()`
        // misbehaving) still gets the guard released, and that failure never
        // escapes `run` — mirroring the unconditional release the
        // pre-extraction per-component `try/catch/finally` gave each island
        // before this hook existed.
        let latch = false;
        try {
          latch = options.onError?.(caught) === true;
        } catch (onErrorFailure) {
          // A broken `onError` is not a "latch" signal — fall through to
          // releasing below. Logged (not swallowed silently) because this can
          // ALSO be a genuine bug in a call site's own handler — e.g. one of
          // the five islands' hand-written `instanceof` checks or rollback
          // logic — and that must leave a trace rather than vanish with no
          // way to diagnose "why didn't my rollback fire?".
          console.error(
            "useAsyncAction: onError threw while handling a failure",
            { caught, onErrorFailure },
          );
        } finally {
          if (!latch) {
            running.current = false;
            setBusy(false);
          }
        }
      }
    },
    [],
  );

  return { busy, error, setError, running, run };
}
