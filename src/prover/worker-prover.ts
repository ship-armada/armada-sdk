// ABOUTME: Worker prover (SPEC §4.5) — a message protocol + main-thread ProverAdapter + a worker-side
// ABOUTME: handler. The consumer supplies the env's Worker (browser Web Worker); snarkjs runs in it.

import type { ProverAdapter, ArtifactSet, Groth16Proof, ProveOptions, ProofProgress } from './index';
import { createSnarkjsProver } from './snarkjs-prover';
import { AbortedError, ProverWorkerError } from '../errors';

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
   * when the worker dies (e.g. OOM on a large zkey), and the next request starts a fresh worker. Omit it
   * and only close() or an abort drains pending requests.
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

interface PendingRequest {
  readonly resolve: (reply: ProverWorkerReply) => void;
  readonly reject: (error: Error) => void;
  readonly onProgress?: (p: ProofProgress) => void;
}

// One started worker and the requests it still owes a reply.
interface LiveWorker {
  readonly channel: WorkerChannel;
  readonly pending: Map<number, PendingRequest>;
}

/**
 * Main-thread `ProverAdapter` over a worker — proving runs off the main thread. `spawn` starts a worker
 * and returns its channel; it is called lazily on the first request, and again after a worker is lost:
 *
 *   - a worker failure (`onError`) rejects that worker's in-flight requests with `ProverWorkerError`;
 *   - aborting an in-flight request terminates the worker (snarkjs can't be interrupted mid-proof, and a
 *     retry must not prove alongside the abandoned proof): the aborted request rejects with
 *     `AbortedError`, any others on that worker with `ProverWorkerError`.
 *
 * Either way the next request starts a fresh worker. `close()` rejects in-flight requests, posts a close
 * request (so the worker terminates its curve threads), terminates the worker, and never spawns another.
 */
export function createWorkerProver(spawn: () => WorkerChannel): ProverAdapter {
  let live: LiveWorker | undefined;
  let nextId = 0;
  let closed = false;

  // Terminate the live worker and fail every request it still owes a reply. Events from a worker that
  // is no longer live (a late error, a stale reply) are ignored.
  const retire = (worker: LiveWorker, error: Error): void => {
    if (live !== worker) return;
    live = undefined;
    const waiting = [...worker.pending.values()];
    worker.pending.clear();
    worker.channel.terminate();
    for (const p of waiting) p.reject(error);
  };

  const liveWorker = (): LiveWorker => {
    if (live !== undefined) return live;
    const worker: LiveWorker = { channel: spawn(), pending: new Map() };
    worker.channel.onMessage((reply) => {
      const p = worker.pending.get(reply.id);
      if (p === undefined) return;
      if ('progress' in reply) {
        p.onProgress?.(reply.progress); // intermediate — forward, keep the request pending
        return;
      }
      worker.pending.delete(reply.id);
      if ('error' in reply) p.reject(new Error(reply.error));
      else p.resolve(reply);
    });
    // A worker crash/exit/transport error must reject in-flight requests, not leave them hanging forever.
    worker.channel.onError?.((error) => {
      const cause = error instanceof Error ? error : new Error(String(error));
      retire(worker, new ProverWorkerError(`prover worker failed: ${cause.message}`, { cause }));
    });
    live = worker;
    return worker;
  };

  const request = (msg: RequestPayload, signal?: AbortSignal, onProgress?: (p: ProofProgress) => void): Promise<ProverWorkerReply> => {
    const id = nextId;
    nextId += 1;
    return new Promise<ProverWorkerReply>((resolve, reject) => {
      if (closed) {
        reject(new ProverWorkerError('worker prover: closed'));
        return;
      }
      if (signal?.aborted) {
        reject(new AbortedError('prove: aborted before start'));
        return;
      }
      const worker = liveWorker();
      const onAbort = (): void => {
        // Reject the caller now, then stop the worker so it doesn't keep running the abandoned proof.
        if (!worker.pending.delete(id)) return;
        reject(new AbortedError('prove: aborted'));
        retire(worker, new ProverWorkerError('prover worker: terminated to cancel another request — retry'));
      };
      worker.pending.set(id, {
        resolve: (r) => { signal?.removeEventListener('abort', onAbort); resolve(r); },
        reject: (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
        ...(onProgress !== undefined ? { onProgress } : {}),
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.channel.post({ ...msg, id } as ProverWorkerRequest);
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
      if (live === undefined) return;
      // Ask the worker to terminate its curve threads, then terminate it (retire) — which also rejects
      // any in-flight requests, since the terminated worker can no longer reply to them.
      const worker = live;
      worker.channel.post({ op: 'close', id: nextId });
      nextId += 1;
      retire(worker, new ProverWorkerError('worker prover: closed'));
    },
  };
}

/** The subset of a browser `Worker` this SDK uses — a real `Worker` satisfies it structurally. */
export interface BrowserWorkerLike {
  postMessage(message: ProverWorkerRequest): void;
  onmessage: ((event: { data: ProverWorkerReply }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  terminate(): void;
}

/**
 * Wrap a browser `Worker` as a `WorkerChannel`. Pair with the prebuilt worker entry so consumers don't
 * hand-write the glue:
 *
 *   const prover = createWorkerProver(() =>
 *     webWorkerChannel(new Worker(new URL('@armada/sdk/prover/worker', import.meta.url), { type: 'module' })),
 *   );
 *
 * Both the worker's `error` event (a crash or a failed script load) and its `messageerror` event (a reply
 * that couldn't be deserialized) are reported through `onError`.
 */
export function webWorkerChannel(worker: BrowserWorkerLike): WorkerChannel {
  return {
    post: (message) => worker.postMessage(message),
    onMessage: (handler) => { worker.onmessage = (event) => handler(event.data); },
    onError: (handler) => {
      worker.onerror = (event) => handler(new Error(event.message ?? 'worker error'));
      worker.onmessageerror = () => handler(new Error('prover worker: a message could not be deserialized'));
    },
    terminate: () => worker.terminate(),
  };
}
