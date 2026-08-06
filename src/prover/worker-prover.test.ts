// ABOUTME: Tests the worker prover protocol + adapter (§4.5) end-to-end via an in-process channel
// ABOUTME: wiring createWorkerProver ↔ createProverWorkerHandler (real snarkjs proof, mul fixture).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWorkerProver, createProverWorkerHandler, type WorkerChannel, type ProverWorkerReply } from './worker-prover';
import type { ArtifactSet } from './index';

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
      await expect(prover.prove({ a: '3', b: '11' }, artifacts, { signal: controller.signal })).rejects.toThrow(/aborted/);
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
});
