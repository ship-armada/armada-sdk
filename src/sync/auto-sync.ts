// ABOUTME: Self-scheduling auto-sync loop (SPEC §4.4, issue #59) — runs a sync fn on an interval with
// ABOUTME: exponential error backoff, so a wallet stays current without the consumer writing a poll loop.

/**
 * Options for {@link startAutoSync}. The timer functions are injectable so the loop is deterministically
 * testable; they default to the global `setTimeout`/`clearTimeout`.
 */
export interface AutoSyncOptions {
  /** Steady-state cadence between sync runs, in ms. */
  readonly intervalMs: number;
  /** Run once immediately on start (default true); set false to wait one `intervalMs` before the first run. */
  readonly immediate?: boolean;
  /** Ceiling on the exponential error backoff, in ms (default 30000 — matches the stock engine's poller). */
  readonly maxBackoffMs?: number;
  /** Called with any error a sync run throws; the loop keeps running (backed off) regardless. */
  readonly onError?: (err: Error) => void;
  /** Schedule `fn` after `ms`; returns a handle passed back to `clearTimer`. Defaults to `setTimeout`. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  /** Cancel a handle from `setTimer`. Defaults to `clearTimeout`. */
  readonly clearTimer?: (handle: unknown) => void;
}

/**
 * Drive `run` on a self-scheduling loop: fire once immediately, then re-schedule `intervalMs` after each
 * run *settles* (never overlapping — the next tick waits for the current one). A throwing run does not
 * kill the loop; it backs off exponentially from `intervalMs` up to `maxBackoffMs`, resetting to
 * `intervalMs` on the next success. Returns a stop function that halts scheduling (an in-flight run
 * finishes but never re-schedules); calling it more than once is safe.
 *
 * Concurrency with manual runs is the caller's concern — `wallet.sync()` already coalesces overlapping
 * runs, so a manual/post-tx refresh landing on top of a tick is safe.
 */
export function startAutoSync(run: () => Promise<unknown>, options: AutoSyncOptions): () => void {
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let running = true;
  let timer: unknown;
  // Current backoff delay; 0 means "no backoff, use intervalMs".
  let backoffMs = 0;

  const schedule = (ms: number): void => {
    if (!running) return;
    timer = setTimer(tick, ms);
    // On Node, unref the timer so a watcher never keeps the process alive on its own (a library must not
    // pin the event loop open). Browser `setTimeout` returns a number with no `unref` — the guard skips it.
    const handle = timer as { unref?: () => void };
    if (typeof handle?.unref === 'function') handle.unref();
  };

  const tick = async (): Promise<void> => {
    if (!running) return;
    try {
      await run();
      backoffMs = 0; // success resets the backoff
    } catch (err) {
      backoffMs = Math.min((backoffMs || options.intervalMs) * 2, maxBackoffMs);
      options.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
    schedule(backoffMs || options.intervalMs);
  };

  // Fire an initial run immediately so the wallet isn't left stale for a full interval on start (matches
  // the stock engine, whose poller runs on start()). Errors are handled inside `tick`. Opt out with
  // `immediate: false` to wait one interval first (e.g. when the caller has just synced explicitly).
  if (options.immediate ?? true) {
    void tick();
  } else {
    schedule(options.intervalMs);
  }

  return (): void => {
    running = false;
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  };
}
