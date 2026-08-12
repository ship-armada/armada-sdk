// ABOUTME: Worker prover (SPEC §4.5) — a message protocol + main-thread ProverAdapter + a worker-side
// ABOUTME: handler. The consumer supplies the env's Worker (browser Web Worker); snarkjs runs in it.

import type { ProverAdapter, ArtifactSet, Groth16Proof, ProveOptions, ProofProgress } from './index';
import { createSnarkjsProver } from './snarkjs-prover';
import { AbortedError } from '../errors';

/**
 * Why not worker_threads here: snarkjs/ffjavascript pulls in the `web-worker` polyfill, which fails
 * when snarkjs is `require`d *inside* a node worker_threads worker (nested-worker collision). It runs
 * fine inside a browser Web Worker, so the SDK ships the protocol + handler and the consumer wires
 * their Worker (Vite/webpack own the worker-entry bundling). node stays on `createSnarkjsProver`.
 */

// ── Message protocol ──
export type ProverWorkerRequest =
  | { readonly id: number; readonly op: 'prove'; readonly input: unknown; readonly wasm: Uint8Array; readonly zkey: Uint8Array }
  | { readonly id: number; readonly op: 'verify'; readonly proof: Groth16Proof; readonly publicSignals: string[]; readonly vkey: object }
  | { readonly id: number; readonly op: 'close' };

export type ProverWorkerReply =
  | { readonly id: number; readonly proof: Groth16Proof }
  | { readonly id: number; readonly ok: boolean }
  | { readonly id: number; readonly progress: ProofProgress } // intermediate — does NOT settle the request
  | { readonly id: number; readonly error: string };

// Distributive omit so each request union member keeps its discriminant-specific fields.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RequestPayload = DistributiveOmit<ProverWorkerRequest, 'id'>;

/** A minimal message channel to a worker — satisfied by both a browser Web Worker and a test double. */
export interface WorkerChannel {
  post(message: ProverWorkerRequest): void;
  onMessage(handler: (reply: ProverWorkerReply) => void): void;
  /**
   * Optional: report a worker-level failure (crash / exit / transport error). Wire it to the Web
   * Worker's `error`/`messageerror` events so an in-flight `prove()` REJECTS instead of hanging forever
   * when the worker dies (e.g. OOM on a large zkey). Omit it and only close() drains pending requests.
   */
  onError?(handler: (error: Error) => void): void;
  terminate(): void;
}

/**
 * Worker-side handler. Run this INSIDE the worker (browser Web Worker), wiring `post` to the worker's
 * `postMessage`; feed it each incoming request. It proves/verifies via the (in-worker) snarkjs prover.
 */
export function createProverWorkerHandler(
  post: (reply: ProverWorkerReply) => void,
  proverFactory: () => ProverAdapter = createSnarkjsProver,
): (request: ProverWorkerRequest) => Promise<void> {
  const prover = proverFactory();
  return async (request: ProverWorkerRequest): Promise<void> => {
    try {
      if (request.op === 'prove') {
        const proof = await prover.prove(request.input, { wasm: request.wasm, zkey: request.zkey } as ArtifactSet, {
          onProgress: (p) => post({ id: request.id, progress: p }), // forward real witness/proving phases across the channel
        });
        post({ id: request.id, proof });
      } else if (request.op === 'verify') {
        const ok = await prover.verify(request.proof, request.publicSignals.map((s) => BigInt(s)), request.vkey);
        post({ id: request.id, ok });
      } else {
        await prover.close();
      }
    } catch (err) {
      post({ id: request.id, error: err instanceof Error ? err.message : String(err) });
    }
  };
}

/**
 * Main-thread `ProverAdapter` over a `WorkerChannel` — proving runs off the main thread in the worker.
 * `close()` posts a close request (so the worker terminates its curve threads) then terminates the channel.
 */
export function createWorkerProver(channel: WorkerChannel): ProverAdapter {
  const pending = new Map<
    number,
    { resolve: (r: ProverWorkerReply) => void; reject: (e: Error) => void; onProgress?: (p: ProofProgress) => void }
  >();
  let nextId = 0;
  let closed = false;

  // Fail every in-flight request at once — used on close() and on a worker-level error.
  const rejectAll = (error: Error): void => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };

  channel.onMessage((reply) => {
    const p = pending.get(reply.id);
    if (p === undefined) return;
    if ('progress' in reply) {
      p.onProgress?.(reply.progress); // intermediate — forward, keep the request pending
      return;
    }
    pending.delete(reply.id);
    if ('error' in reply) p.reject(new Error(reply.error));
    else p.resolve(reply);
  });
  // A worker crash/exit/transport error must reject in-flight requests, not leave them hanging forever.
  channel.onError?.((error) => rejectAll(error instanceof Error ? error : new Error(String(error))));

  const request = (msg: RequestPayload, signal?: AbortSignal, onProgress?: (p: ProofProgress) => void): Promise<ProverWorkerReply> => {
    const id = nextId;
    nextId += 1;
    return new Promise<ProverWorkerReply>((resolve, reject) => {
      if (closed) {
        reject(new Error('worker prover: closed'));
        return;
      }
      if (signal?.aborted) {
        reject(new AbortedError('prove: aborted before start'));
        return;
      }
      const onAbort = (): void => {
        // Drop the pending entry so a later reply is ignored, and reject the caller (no worker respawn —
        // the worker keeps running the abandoned proof, but the caller is unblocked immediately).
        if (pending.delete(id)) reject(new AbortedError('prove: aborted'));
      };
      pending.set(id, {
        resolve: (r) => { signal?.removeEventListener('abort', onAbort); resolve(r); },
        reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
        ...(onProgress !== undefined ? { onProgress } : {}),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      channel.post({ ...msg, id } as ProverWorkerRequest);
    });
  };

  return {
    async prove(formattedInputs: unknown, artifacts: ArtifactSet, options?: ProveOptions): Promise<Groth16Proof> {
      if (options?.signal?.aborted) throw new AbortedError('prove: aborted before start');
      // Real progress now crosses the channel from the in-worker prover (witness → proving phases).
      const reply = await request(
        { op: 'prove', input: formattedInputs, wasm: artifacts.wasm, zkey: artifacts.zkey },
        options?.signal,
        options?.onProgress,
      );
      return (reply as { proof: Groth16Proof }).proof;
    },
    async verify(proof: Groth16Proof, publicSignals: bigint[], vkey: object): Promise<boolean> {
      const reply = await request({ op: 'verify', proof, publicSignals: publicSignals.map((s) => s.toString()), vkey });
      return (reply as { ok: boolean }).ok;
    },
    async close(): Promise<void> {
      closed = true;
      // Reject any in-flight requests so awaiting callers don't hang once the worker is terminated
      // (terminate() below kills the worker before it can reply to the graceful close op).
      rejectAll(new Error('worker prover: closed'));
      channel.post({ op: 'close', id: nextId });
      nextId += 1;
      channel.terminate();
    },
  };
}

/** The subset of a browser `Worker` this SDK uses — a real `Worker` satisfies it structurally. */
export interface BrowserWorkerLike {
  postMessage(message: ProverWorkerRequest): void;
  onmessage: ((event: { data: ProverWorkerReply }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  terminate(): void;
}

/**
 * Wrap a browser `Worker` as a `WorkerChannel`. Pair with the prebuilt worker entry so consumers don't
 * hand-write the glue:
 *
 *   const worker = new Worker(new URL('@armada/sdk/prover/worker', import.meta.url), { type: 'module' });
 *   const prover = createWorkerProver(webWorkerChannel(worker));
 */
export function webWorkerChannel(worker: BrowserWorkerLike): WorkerChannel {
  return {
    post: (message) => worker.postMessage(message),
    onMessage: (handler) => { worker.onmessage = (event) => handler(event.data); },
    onError: (handler) => { worker.onerror = (event) => handler(new Error(event.message ?? 'worker error')); },
    terminate: () => worker.terminate(),
  };
}
