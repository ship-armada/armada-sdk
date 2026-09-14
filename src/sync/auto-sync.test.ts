// ABOUTME: Tests for the auto-sync loop (issue #59) — immediate first run, no-overlap rescheduling,
// ABOUTME: exponential error backoff with cap + reset, and stop() semantics. Uses an injected scheduler.

import { describe, it, expect } from 'vitest';
import { startAutoSync } from './auto-sync';

// A controllable scheduler: captures the pending callback and every delay requested, and lets the test
// fire the scheduled tick on demand — no real timers, fully deterministic.
function harness() {
  let pending: { fn: () => void } | null = null;
  const delays: number[] = [];
  return {
    setTimer: (fn: () => void, ms: number): unknown => {
      pending = { fn };
      delays.push(ms);
      return { unref() {} };
    },
    clearTimer: (): void => {
      pending = null;
    },
    runScheduled(): void {
      const p = pending;
      pending = null;
      p?.fn();
    },
    delays,
    get hasPending(): boolean {
      return pending !== null;
    },
  };
}

// Drain the microtask queue so an awaited async run() settles and the loop re-schedules.
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('startAutoSync (issue #59)', () => {
  it('runs immediately, then reschedules at intervalMs after each run settles', async () => {
    const h = harness();
    let runs = 0;
    const stop = startAutoSync(async () => { runs += 1; }, {
      intervalMs: 10_000,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    await flush();
    expect(runs).toBe(1); // fired immediately, not after a full interval
    expect(h.delays).toEqual([10_000]);

    h.runScheduled();
    await flush();
    expect(runs).toBe(2);
    expect(h.delays).toEqual([10_000, 10_000]);
    stop();
  });

  it('with immediate:false, waits one interval before the first run', async () => {
    const h = harness();
    let runs = 0;
    const stop = startAutoSync(async () => { runs += 1; }, {
      intervalMs: 10_000,
      immediate: false,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    await flush();
    expect(runs).toBe(0); // nothing ran yet
    expect(h.delays).toEqual([10_000]); // first run scheduled, not immediate

    h.runScheduled();
    await flush();
    expect(runs).toBe(1);
    stop();
  });

  it('does not schedule the next run until the current run settles (no overlap)', async () => {
    const h = harness();
    let resolve!: () => void;
    const gate = new Promise<void>((r) => { resolve = r; });
    const stop = startAutoSync(() => gate, { intervalMs: 10_000, setTimer: h.setTimer, clearTimer: h.clearTimer });
    await flush();
    expect(h.hasPending).toBe(false); // run in flight → nothing scheduled yet
    expect(h.delays).toEqual([]);

    resolve();
    await flush();
    expect(h.delays).toEqual([10_000]); // scheduled only after the run settled
    stop();
  });

  it('backs off exponentially on error, caps at maxBackoffMs, and resets on success', async () => {
    const h = harness();
    let mode: 'throw' | 'ok' = 'throw';
    const stop = startAutoSync(
      async () => {
        if (mode === 'throw') throw new Error('boom');
      },
      { intervalMs: 1_000, maxBackoffMs: 5_000, setTimer: h.setTimer, clearTimer: h.clearTimer },
    );
    await flush(); // immediate run throws → 1000*2
    expect(h.delays).toEqual([2_000]);

    h.runScheduled();
    await flush(); // throws → 2000*2
    expect(h.delays).toEqual([2_000, 4_000]);

    h.runScheduled();
    await flush(); // throws → 4000*2 capped at 5000
    expect(h.delays).toEqual([2_000, 4_000, 5_000]);

    mode = 'ok';
    h.runScheduled();
    await flush(); // success → back to intervalMs
    expect(h.delays).toEqual([2_000, 4_000, 5_000, 1_000]);
    stop();
  });

  it('forwards errors to onError while keeping the loop running', async () => {
    const h = harness();
    const errors: string[] = [];
    const stop = startAutoSync(async () => { throw new Error('nope'); }, {
      intervalMs: 1_000,
      onError: (e) => errors.push(e.message),
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });
    await flush();
    expect(errors).toEqual(['nope']);

    h.runScheduled();
    await flush();
    expect(errors).toEqual(['nope', 'nope']); // still looping after an error
    stop();
  });

  it('stop() halts scheduling, clears the pending timer, and is idempotent', async () => {
    const h = harness();
    let runs = 0;
    const stop = startAutoSync(async () => { runs += 1; }, { intervalMs: 1_000, setTimer: h.setTimer, clearTimer: h.clearTimer });
    await flush();
    expect(runs).toBe(1);

    stop();
    expect(h.hasPending).toBe(false);
    stop(); // idempotent — no throw

    await flush();
    expect(runs).toBe(1); // no further runs after stop
  });
});
