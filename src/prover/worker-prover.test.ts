// ABOUTME: Tests the worker prover protocol + adapter (§4.5) end-to-end via an in-process channel
// ABOUTME: wiring createWorkerProver ↔ createProverWorkerHandler (real snarkjs proof, mul fixture) + worker lifecycle.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createWorkerProver, createProverWorkerHandler, webWorkerChannel,
  type WorkerChannel, type ProverWorkerReply, type BrowserWorkerLike,
} from './worker-prover';
import { createSnarkjsProver } from './snarkjs-prover';
import type { ArtifactSet } from './index';
import { AbortedError, ProverWorkerError } from '../errors';

const fixture = (name: string): string => fileURLToPath(new URL(`../../test/fixtures/prover/${name}`, import.meta.url));
const artifacts: ArtifactSet = {
  wasm: new Uint8Array(readFileSync(fixture('mul.wasm'))),
  zkey: new Uint8Array(readFileSync(fixture('mul.zkey'))),
  vkey: JSON.parse(readFileSync(fixture('mul.vkey.json'), 'utf8')) as object,
};

// An in-process channel: the adapter's requests drive the handler; the handler's replies drive the
// adapter. Stands in for the real worker transport (which the consumer's Web Worker provides).
// terminate() closes the in-"worker" prover, as killing a real worker takes its curve threads with it.
function inProcessChannel(): WorkerChannel {
  let deliver: (reply: ProverWorkerReply) => void = () => {};
  const prover = createSnarkjsProver();
  const handle = createProverWorkerHandler((reply) => deliver(reply), () => prover);
  return {
    post: (request) => { void handle(request); },
    onMessage: (h) => { deliver = h; },
    terminate: () => { void prover.close(); },
  };
}

describe('worker prover protocol + adapter (§4.5)', () => {
  it('proves and verifies through the message channel, forwarding real progress phases (P4.5)', async () => {
    const prover = createWorkerProver(inProcessChannel);
    try {
      const progress: string[] = [];
      const proof = await prover.prove({ a: '3', b: '11' }, artifacts, { onProgress: (p) => progress.push(p.phase) });
      expect(proof.a).toHaveLength(2);
      expect(proof.b[0]).toHaveLength(2);
      // The in-worker prover's witness→proving phases cross the channel to the main-thread caller.
      expect(progress).toContain('witness');
      expect(progress).toContain('proving');
      expect(await prover.verify(proof, [33n], artifacts.vkey)).toBe(true);
      expect(await prover.verify(proof, [34n], artifacts.vkey)).toBe(false);
    } finally {
      await prover.close();
    }
  });

  it('rejects proving when the abort signal is already set', async () => {
    const prover = createWorkerProver(inProcessChannel);
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(prover.prove({ a: '3', b: '11' }, artifacts, { signal: controller.signal })).rejects.toBeInstanceOf(AbortedError);
    } finally {
      await prover.close();
    }
  });

  it('propagates worker-side errors back to the caller', async () => {
    const prover = createWorkerProver(inProcessChannel);
    try {
      // Empty artifacts make snarkjs.fullProve throw inside the handler → surfaced as a rejection.
      await expect(prover.prove({ a: '3', b: '11' }, { wasm: new Uint8Array(), zkey: new Uint8Array(), vkey: {} })).rejects.toThrow();
    } finally {
      await prover.close();
    }
  });

  // A channel that never replies — models a proof in flight (or a dead worker) so we can test the
  // rejection paths that would otherwise hang the caller forever (M9). `fail` fires the worker's error.
  type SilentChannel = WorkerChannel & { fail: (e: Error) => void; terminated: boolean };
  const silentChannel = (): SilentChannel => {
    const ch: SilentChannel = {
      fail: () => {},
      terminated: false,
      post: () => {},
      onMessage: () => {},
      onError: (h) => { ch.fail = h; },
      terminate: () => { ch.terminated = true; },
    };
    return ch;
  };
  // A spawner that records every worker it starts, handing out `next()` for each spawn.
  const recordingSpawner = <C extends WorkerChannel>(next: () => C): { spawn: () => C; spawned: C[] } => {
    const spawned: C[] = [];
    return { spawned, spawn: () => { const ch = next(); spawned.push(ch); return ch; } };
  };

  it('starts the worker lazily on the first request and reuses it', async () => {
    const workers = recordingSpawner(inProcessChannel);
    const prover = createWorkerProver(workers.spawn);
    try {
      expect(workers.spawned).toHaveLength(0);
      const proof = await prover.prove({ a: '3', b: '11' }, artifacts);
      expect(await prover.verify(proof, [33n], artifacts.vkey)).toBe(true);
      expect(workers.spawned).toHaveLength(1);
    } finally {
      await prover.close();
    }
  });

  it('rejects in-flight requests on close() instead of hanging (M9), and refuses requests after', async () => {
    const workers = recordingSpawner(silentChannel);
    const prover = createWorkerProver(workers.spawn);
    const inFlight = prover.prove({ a: '3', b: '11' }, artifacts);
    await prover.close();
    await expect(inFlight).rejects.toBeInstanceOf(ProverWorkerError);
    await expect(inFlight).rejects.toThrow(/closed/);
    expect(workers.spawned[0]!.terminated).toBe(true);
    await expect(prover.prove({ a: '3', b: '11' }, artifacts)).rejects.toThrow(/closed/);
    expect(workers.spawned).toHaveLength(1); // a closed prover never starts another worker
  });

  it('rejects in-flight requests with ProverWorkerError when the worker crashes (M9), then starts a fresh worker', async () => {
    // WHY: a crashed worker (e.g. OOM on a large zkey) can never reply. Its requests must fail with a
    // typed, retryable error, and the retry must reach a live worker instead of the dead one.
    const crash = new Error('worker crashed (OOM)');
    let spawns = 0;
    const workers = recordingSpawner((): WorkerChannel => (spawns++ === 0 ? silentChannel() : inProcessChannel()));
    const prover = createWorkerProver(workers.spawn);
    try {
      const inFlight = prover.prove({ a: '3', b: '11' }, artifacts);
      (workers.spawned[0] as SilentChannel).fail(crash);
      const err = await inFlight.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProverWorkerError);
      expect((err as Error).message).toMatch(/OOM/);
      expect((err as Error).cause).toBe(crash);
      expect((workers.spawned[0] as SilentChannel).terminated).toBe(true);

      const retried = await prover.prove({ a: '3', b: '11' }, artifacts);
      expect(retried.a).toHaveLength(2);
      expect(workers.spawned).toHaveLength(2);
    } finally {
      await prover.close();
    }
  });

  it('starts a fresh worker when an idle worker fails, ignoring later events from the retired one', async () => {
    // An in-process worker that also exposes its error event, so the test can crash it between requests.
    const failable = (): WorkerChannel & { fail: (e: Error) => void } => {
      const ch = { ...inProcessChannel(), fail: ((): void => {}) as (e: Error) => void };
      ch.onError = (h): void => { ch.fail = h; };
      return ch;
    };
    const workers = recordingSpawner(failable);
    const prover = createWorkerProver(workers.spawn);
    try {
      await prover.prove({ a: '3', b: '11' }, artifacts);
      workers.spawned[0]!.fail(new Error('worker died while idle'));
      workers.spawned[0]!.fail(new Error('late duplicate error')); // a retired worker's events are ignored
      const proof = await prover.prove({ a: '3', b: '11' }, artifacts);
      expect(proof.a).toHaveLength(2);
      expect(workers.spawned).toHaveLength(2);
    } finally {
      await prover.close();
    }
  });

  it('terminates the worker when an in-flight prove is aborted, failing its other requests retryably', async () => {
    // WHY: a worker can't interrupt snarkjs mid-proof. Leaving it running meant a retry proved
    // concurrently with the abandoned proof (double the memory on a real zkey); terminating it frees
    // the worker now, and the next request starts a fresh one.
    let spawns = 0;
    const workers = recordingSpawner((): WorkerChannel => (spawns++ === 0 ? silentChannel() : inProcessChannel()));
    const prover = createWorkerProver(workers.spawn);
    try {
      const controller = new AbortController();
      const aborted = prover.prove({ a: '3', b: '11' }, artifacts, { signal: controller.signal });
      const sibling = prover.prove({ a: '5', b: '7' }, artifacts);
      controller.abort();
      await expect(aborted).rejects.toBeInstanceOf(AbortedError);
      await expect(sibling).rejects.toBeInstanceOf(ProverWorkerError);
      expect((workers.spawned[0] as SilentChannel).terminated).toBe(true);

      const retried = await prover.prove({ a: '3', b: '11' }, artifacts);
      expect(retried.a).toHaveLength(2);
      expect(workers.spawned).toHaveLength(2);
    } finally {
      await prover.close();
    }
  });
});

describe('webWorkerChannel', () => {
  // A stand-in for a browser Worker: records posts/termination and lets the test fire its events.
  const fakeWorker = (): BrowserWorkerLike & { terminated: boolean } => ({
    terminated: false,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: () => {},
    terminate() { this.terminated = true; },
  });

  it('reports both error and messageerror events as worker failures', () => {
    const worker = fakeWorker();
    const channel = webWorkerChannel(worker);
    const failures: string[] = [];
    channel.onError!((e) => failures.push(e.message));
    worker.onerror!({ message: 'script error' });
    worker.onmessageerror!({});
    expect(failures).toEqual(['script error', 'prover worker: a message could not be deserialized']);
  });
});
