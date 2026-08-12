// ABOUTME: Tests the worker prover protocol + adapter (§4.5) end-to-end via an in-process channel
// ABOUTME: wiring createWorkerProver ↔ createProverWorkerHandler (real snarkjs proof, mul fixture).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWorkerProver, createProverWorkerHandler, type WorkerChannel, type ProverWorkerReply } from './worker-prover';
import type { ArtifactSet } from './index';
import { AbortedError } from '../errors';

const fixture = (name: string): string => fileURLToPath(new URL(`../../test/fixtures/prover/${name}`, import.meta.url));
const artifacts: ArtifactSet = {
  wasm: new Uint8Array(readFileSync(fixture('mul.wasm'))),
  zkey: new Uint8Array(readFileSync(fixture('mul.zkey'))),
  vkey: JSON.parse(readFileSync(fixture('mul.vkey.json'), 'utf8')) as object,
};

// An in-process channel: the adapter's requests drive the handler; the handler's replies drive the
// adapter. Stands in for the real worker transport (which the consumer's Web Worker provides).
function inProcessChannel(): WorkerChannel {
  let deliver: (reply: ProverWorkerReply) => void = () => {};
  const handle = createProverWorkerHandler((reply) => deliver(reply));
  return {
    post: (request) => { void handle(request); },
    onMessage: (h) => { deliver = h; },
    terminate: () => {},
  };
}

describe('worker prover protocol + adapter (§4.5)', () => {
  it('proves and verifies through the message channel (real snarkjs)', async () => {
    const prover = createWorkerProver(inProcessChannel());
    try {
      const proof = await prover.prove({ a: '3', b: '11' }, artifacts);
      expect(proof.a).toHaveLength(2);
      expect(proof.b[0]).toHaveLength(2);
      expect(await prover.verify(proof, [33n], artifacts.vkey)).toBe(true);
      expect(await prover.verify(proof, [34n], artifacts.vkey)).toBe(false);
    } finally {
      await prover.close();
    }
  });

  it('rejects proving when the abort signal is already set', async () => {
    const prover = createWorkerProver(inProcessChannel());
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(prover.prove({ a: '3', b: '11' }, artifacts, { signal: controller.signal })).rejects.toBeInstanceOf(AbortedError);
    } finally {
      await prover.close();
    }
  });

  it('propagates worker-side errors back to the caller', async () => {
    const prover = createWorkerProver(inProcessChannel());
    try {
      // Empty artifacts make snarkjs.fullProve throw inside the handler → surfaced as a rejection.
      await expect(prover.prove({ a: '3', b: '11' }, { wasm: new Uint8Array(), zkey: new Uint8Array(), vkey: {} })).rejects.toThrow();
    } finally {
      await prover.close();
    }
  });

  // A channel that never replies — models a proof in flight (or a dead worker) so we can test the
  // rejection paths that would otherwise hang the caller forever (M9).
  const silentChannel = (): WorkerChannel & { fail?: (e: Error) => void } => {
    const ch: WorkerChannel & { fail?: (e: Error) => void } = {
      post: () => {},
      onMessage: () => {},
      onError: (h) => { ch.fail = h; },
      terminate: () => {},
    };
    return ch;
  };

  it('rejects in-flight requests on close() instead of hanging (M9)', async () => {
    const prover = createWorkerProver(silentChannel());
    const inFlight = prover.prove({ a: '3', b: '11' }, artifacts);
    await prover.close();
    await expect(inFlight).rejects.toThrow(/closed/);
  });

  it('rejects in-flight requests when the worker reports an error (M9)', async () => {
    const ch = silentChannel();
    const prover = createWorkerProver(ch);
    try {
      const inFlight = prover.prove({ a: '3', b: '11' }, artifacts);
      ch.fail!(new Error('worker crashed (OOM)'));
      await expect(inFlight).rejects.toThrow(/OOM/);
    } finally {
      await prover.close();
    }
  });

  it('rejects an in-flight prove when its AbortSignal fires (M9)', async () => {
    const prover = createWorkerProver(silentChannel());
    try {
      const controller = new AbortController();
      const inFlight = prover.prove({ a: '3', b: '11' }, artifacts, { signal: controller.signal });
      controller.abort();
      await expect(inFlight).rejects.toBeInstanceOf(AbortedError);
    } finally {
      await prover.close();
    }
  });
});
