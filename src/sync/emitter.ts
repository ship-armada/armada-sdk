// ABOUTME: SyncEmitter — a tiny typed multi-listener event bus over SyncEventMap. Replaces the stock
// ABOUTME: engine's single global balance callback; a wallet owns one and emits scan/balance events on sync().

import type { SyncEventMap } from './index';

/** Detaches a listener registered via `SyncEmitter.on`. Idempotent. */
export type Unsubscribe = () => void;

type ListenerSets = { [K in keyof SyncEventMap]: Set<(payload: SyncEventMap[K]) => void> };

/**
 * Typed fan-out for scan/balance events. Unlike the stock `setOnBalanceUpdateCallback` (one global
 * callback), any number of listeners can subscribe per event. A throwing listener is isolated — it
 * never breaks a scan or the other listeners.
 */
export class SyncEmitter {
  private readonly listeners: ListenerSets = {
    'scan:started': new Set(),
    'scan:progress': new Set(),
    'scan:complete': new Set(),
    'scan:error': new Set(),
    'balance:updated': new Set(),
    'note:received': new Set(),
  };

  on<K extends keyof SyncEventMap>(event: K, listener: (payload: SyncEventMap[K]) => void): Unsubscribe {
    this.listeners[event].add(listener);
    return () => {
      this.listeners[event].delete(listener);
    };
  }

  emit<K extends keyof SyncEventMap>(event: K, payload: SyncEventMap[K]): void {
    // Snapshot so a listener that (un)subscribes during dispatch doesn't perturb this pass.
    for (const listener of [...this.listeners[event]]) {
      try {
        listener(payload);
      } catch {
        // A single bad listener must never break a scan or the other listeners.
      }
    }
  }
}
