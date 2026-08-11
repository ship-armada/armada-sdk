// ABOUTME: Unit tests for SyncEmitter — multi-listener fan-out, typed payloads, unsubscribe, and
// ABOUTME: listener-error isolation (one throwing listener must not break the others or the scan).

import { describe, it, expect, vi } from 'vitest';
import { SyncEmitter } from './emitter';

describe('SyncEmitter', () => {
  it('fans a payload out to every listener on the event', () => {
    const e = new SyncEmitter();
    const a = vi.fn();
    const b = vi.fn();
    e.on('scan:complete', a);
    e.on('scan:complete', b);
    e.emit('scan:complete', { syncedThrough: 42 });
    expect(a).toHaveBeenCalledWith({ syncedThrough: 42 });
    expect(b).toHaveBeenCalledWith({ syncedThrough: 42 });
  });

  it('scopes listeners to their event', () => {
    const e = new SyncEmitter();
    const onComplete = vi.fn();
    e.on('scan:complete', onComplete);
    e.emit('scan:started', { fromBlock: 1, toBlock: 2 });
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('unsubscribe detaches exactly one listener', () => {
    const e = new SyncEmitter();
    const a = vi.fn();
    const b = vi.fn();
    const off = e.on('balance:updated', a);
    e.on('balance:updated', b);
    off();
    e.emit('balance:updated', { tokenAddress: `0x${'ab'.repeat(20)}`, spendable: 1n, pending: 0n });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });

  it('isolates a throwing listener from the others', () => {
    const e = new SyncEmitter();
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    e.on('scan:complete', bad);
    e.on('scan:complete', good);
    expect(() => e.emit('scan:complete', { syncedThrough: 1 })).not.toThrow();
    expect(good).toHaveBeenCalledOnce();
  });

  it('a listener that unsubscribes during dispatch does not perturb the in-flight pass', () => {
    const e = new SyncEmitter();
    const calls: string[] = [];
    const off = e.on('scan:complete', () => { calls.push('a'); off(); });
    e.on('scan:complete', () => { calls.push('b'); });
    e.emit('scan:complete', { syncedThrough: 1 });
    e.emit('scan:complete', { syncedThrough: 2 });
    // First pass hits both; second pass only b (a detached itself).
    expect(calls).toEqual(['a', 'b', 'b']);
  });
});
