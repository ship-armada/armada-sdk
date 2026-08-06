// ABOUTME: Worker prover (SPEC §4.5) — a message protocol + main-thread ProverAdapter + a worker-side
// ABOUTME: handler. The consumer supplies the env's Worker (browser Web Worker); snarkjs runs in it.

import type { ProverAdapter, ArtifactSet, Groth16Proof, ProveOptions } from './index';
import { createSnarkjsProver } from './snarkjs-prover';

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
  | { readonly id: number; readonly error: string };

// Distributive omit so each request union member keeps its discriminant-specific fields.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RequestPayload = DistributiveOmit<ProverWorkerRequest, 'id'>;

/** A minimal message channel to a worker — satisfied by both a browser Web Worker and a test double. */
export interface WorkerChannel {
  post(message: ProverWorkerRequest): void;
  onMessage(handler: (reply: ProverWorkerReply) => void): void;
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
        const proof = await prover.prove(request.input, { wasm: request.wasm, zkey: request.zkey } as ArtifactSet);
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
  const pending = new Map<number, { resolve: (r: ProverWorkerReply) => void; reject: (e: Error) => void }>();
  let nextId = 0;
  channel.onMessage((reply) => {
    const p = pending.get(reply.id);
    if (p === undefined) return;
    pending.delete(reply.id);
    if ('error' in reply) p.reject(new Error(reply.error));
    else p.resolve(reply);
  });

  const request = (msg: RequestPayload): Promise<ProverWorkerReply> => {
    const id = nextId;
    nextId += 1;
    return new Promise<ProverWorkerReply>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      channel.post({ ...msg, id } as ProverWorkerRequest);
    });
  };

  return {
    async prove(formattedInputs: unknown, artifacts: ArtifactSet, options?: ProveOptions): Promise<Groth16Proof> {
      if (options?.signal?.aborted) throw new Error('prove: aborted before start');
      options?.onProgress?.({ phase: 'proving', fraction: 0 });
      const reply = await request({ op: 'prove', input: formattedInputs, wasm: artifacts.wasm, zkey: artifacts.zkey });
      options?.onProgress?.({ phase: 'proving', fraction: 1 });
      return (reply as { proof: Groth16Proof }).proof;
    },
    async verify(proof: Groth16Proof, publicSignals: bigint[], vkey: object): Promise<boolean> {
      const reply = await request({ op: 'verify', proof, publicSignals: publicSignals.map((s) => s.toString()), vkey });
      return (reply as { ok: boolean }).ok;
    },
    async close(): Promise<void> {
      channel.post({ op: 'close', id: nextId });
      nextId += 1;
      channel.terminate();
    },
  };
}
