// ABOUTME: Repro tests for the worker prover (review): missing in-worker self-check, typed-error loss,
// ABOUTME: early worker load failure hanging later proofs, and abort not stopping the worker.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createWorkerProver, createProverWorkerHandler, type WorkerChannel, type ProverWorkerReply, type ProverWorkerRequest } from '../../../src/prover/worker-prover';
import { createSnarkjsProver } from '../../../src/prover/snarkjs-prover';
import type { ArtifactSet, ProverAdapter } from '../../../src/prover/index';
import { ProofVerificationError, ArtifactIntegrityError } from '../../../src/errors';

const fixture = (name: string): string => fileURLToPath(new URL(`../../../test/fixtures/prover/${name}`, import.meta.url));
const artifacts: ArtifactSet = {
  wasm: new Uint8Array(readFileSync(fixture('mul.wasm'))),
  zkey: new Uint8Array(readFileSync(fixture('mul.zkey'))),
  vkey: JSON.parse(readFileSync(fixture('mul.vkey.json'), 'utf8')) as object,
};
const wrongVkey = (): object => {
  const v = JSON.parse(readFileSync(fixture('mul.vkey.json'), 'utf8')) as { IC: string[][] };
  v.IC[0]![0] = (BigInt(v.IC[0]![0]!) + 1n).toString();
  return v;
};

function inProcessChannel(factory?: () => ProverAdapter): WorkerChannel & { seen: ProverWorkerRequest[] } {
  let deliver: (reply: ProverWorkerReply) => void = () => {};
  const handle = createProverWorkerHandler((reply) => deliver(reply), factory);
  const ch = {
    seen: [] as ProverWorkerRequest[],
    post: (request: ProverWorkerRequest) => { ch.seen.push(request); void handle(request); },
    onMessage: (h: (r: ProverWorkerReply) => void) => { deliver = h; },
    terminate: () => {},
  };
  return ch;
}

const pendingAfter = async (p: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([p.then(() => false, () => false), new Promise<boolean>((r) => setTimeout(() => r(true), ms))]);

describe('worker prover repros', () => {
  it('BUG: same-thread prover rejects a mismatched vkey, worker prover silently accepts it (no self-check)', async () => {
    const same = createSnarkjsProver();
    await expect(same.prove({ a: '3', b: '11' }, { ...artifacts, vkey: wrongVkey() })).rejects.toBeInstanceOf(ProofVerificationError);
    const ch = inProcessChannel();
    const worker = createWorkerProver(ch);
    const proof = await worker.prove({ a: '3', b: '11' }, { ...artifacts, vkey: wrongVkey() });
    expect(proof.a).toHaveLength(2); // resolved: the self-check never ran
    const req = ch.seen[0] as Record<string, unknown>;
    expect('vkey' in req).toBe(false); // vkey is never sent to the worker
    await worker.close();
    await same.close();
  });

  it('BUG: typed errors lose their class/code across the worker boundary', async () => {
    const throwing = (): ProverAdapter => ({
      prove: async () => { throw new ProofVerificationError('bad'); },
      verify: async () => { throw new ArtifactIntegrityError('x'); },
      close: async () => {},
    });
    const worker = createWorkerProver(inProcessChannel(throwing));
    const err = await worker.prove({}, artifacts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ProofVerificationError);
    expect((err as { code?: string }).code).toBeUndefined();
    await worker.close();
  });

  it('BUG: a worker error that fires before any request is swallowed; later prove() hangs forever', async () => {
    let fail: (e: Error) => void = () => {};
    const dead: WorkerChannel = {
      post: () => {}, // worker script failed to load: messages go nowhere
      onMessage: () => {},
      onError: (h) => { fail = h; },
      terminate: () => {},
    };
    const prover = createWorkerProver(dead);
    fail(new Error('worker script 404')); // e.g. bad bundler URL — fires at startup, nothing pending
    const p = prover.prove({ a: '3', b: '11' }, artifacts);
    expect(await pendingAfter(p, 300)).toBe(true); // still pending — no timeout, no failed state
    await prover.close();
    await expect(p).rejects.toThrow(/closed/);
  });

  it('BUG: abort unblocks the caller but the worker keeps proving; a retry runs concurrently in the worker', async () => {
    let active = 0; let maxActive = 0;
    const slow = (): ProverAdapter => ({
      prove: async () => { active += 1; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 200)); active -= 1; return { a: ['1', '2'], b: [['1', '2'], ['3', '4']], c: ['1', '2'] }; },
      verify: async () => true,
      close: async () => {},
    });
    const worker = createWorkerProver(inProcessChannel(slow));
    const ac = new AbortController();
    const first = worker.prove({}, artifacts, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(first).rejects.toThrow(/aborted/);
    await worker.prove({}, artifacts); // user retries
    expect(maxActive).toBe(2); // two proofs in the worker at once (memory x2 on real zkeys)
    await worker.close();
  });
});
