// ABOUTME: Type-level tests for the telemetry contract (SPEC §8, #129) — `TelemetrySink.emit` accepts only the events
// ABOUTME: the SDK emits, each with its exact payload, so a PII field can't be added to an event unnoticed.

import { describe, it, expect } from 'vitest';
import type { TelemetrySink, TelemetryEventMap } from './index';

describe('TelemetrySink (SPEC §8)', () => {
  it('types every event with its payload, rejecting unknown events and extra fields', () => {
    // WHY: payloads were `Record<string, unknown>`, so the §8 rule (no keys, addresses, amounts) couldn't be
    // checked by the compiler. The `@ts-expect-error` lines below are verified by `npm run typecheck`.
    const seen: (keyof TelemetryEventMap)[] = [];
    const sink: TelemetrySink = { emit: (...[event]) => { seen.push(event); } };

    sink.emit('storage.chain-reset', { chainId: 1, deployBlock: 0 });
    sink.emit('sync.reorg-recovery', { fromBlock: 10, reason: 'checkpoint-reorged' });
    sink.emit('sync.quicksync', { outcome: 'served', fromBlock: 1, head: 2, tailCovered: false });
    // @ts-expect-error — an event the SDK doesn't emit
    sink.emit('sync.unknown', {});
    // @ts-expect-error — a field that isn't part of the event's payload (e.g. an address)
    sink.emit('storage.chain-reset', { chainId: 1, deployBlock: 0, address: '0zk1q' });
    // @ts-expect-error — a reason outside the enum
    sink.emit('sync.reorg-recovery', { fromBlock: 10, reason: 'something-else' });

    expect(seen).toEqual(['storage.chain-reset', 'sync.reorg-recovery', 'sync.quicksync', 'sync.unknown', 'storage.chain-reset', 'sync.reorg-recovery']);
  });

  it('narrows the payload by event name inside a sink, with no casts', () => {
    // WHY: a sink forwards some events and ignores others; checking `event` must give it the typed payload.
    const forwarded: string[] = [];
    const sink: TelemetrySink = {
      emit(event, data) {
        if (event === 'sync.quicksync') forwarded.push(`${data.outcome}:${data.head}`);
        else if (event === 'sync.reorg-recovery') forwarded.push(data.reason);
      },
    };
    sink.emit('sync.quicksync', { outcome: 'root-mismatch-fallback', fromBlock: 1, head: 9, tailCovered: false, reason: 'unknown' });
    sink.emit('sync.reorg-recovery', { fromBlock: 1, reason: 'missing-leaves' });
    sink.emit('storage.chain-reset', { chainId: 1, deployBlock: 0 });
    expect(forwarded).toEqual(['root-mismatch-fallback:9', 'missing-leaves']);
  });
});
