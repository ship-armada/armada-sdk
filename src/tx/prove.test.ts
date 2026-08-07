// ABOUTME: Orchestration tests for prove() + ProofHandle (§4.6) — real buildWitness/serialize with a
// ABOUTME: mock prover+artifacts (no Railgun circuit fixture here; real proving is the chain differential).

import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise, getTokenDataERC20 } from '../core/index';
import { deriveKeyset, type Keyset } from '../wallet/derive';
import { LocalSigner } from '../wallet/local-signer';
import { UTXOMerkletree } from '../sync/merkletree';
import { createTransferNote } from '../sync/index';
import { prove } from './prove';
import { buildTransactCalldata, transactionToTuple } from './serialize';
import { decodeTransact } from './decode';
import type { BuildWitnessParams } from './witness';
import type { ArtifactSource, ArtifactSet, ProverAdapter, Groth16Proof, CircuitShape } from '../prover/index';
import type { PlanSummary } from './index';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const POOL = '0x00000000000000000000000000000000000000aa' as const;
const nToHex = (n: bigint): string => n.toString(16).padStart(64, '0');
const DUMMY_PROOF: Groth16Proof = { a: ['1', '2'], b: [['3', '4'], ['5', '6']], c: ['7', '8'] };
const DUMMY_ARTIFACTS: ArtifactSet = { wasm: new Uint8Array(1), zkey: new Uint8Array(1), vkey: {} };

describe('prove() + ProofHandle (§4.6)', () => {
  let sender: Keyset;
  let recipient: Keyset;
  let signer: LocalSigner;

  beforeAll(async () => {
    await initPoseidonPromise;
    sender = await deriveKeyset(new Uint8Array(32).fill(0x11));
    recipient = await deriveKeyset(new Uint8Array(32).fill(0x22));
    signer = await LocalSigner.fromRootSecret(new Uint8Array(32).fill(0x11));
  });

  async function witnessParams(): Promise<BuildWitnessParams> {
    const tokenData = getTokenDataERC20(USDC);
    const note = createTransferNote({
      receiverAddressData: { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey },
      senderAddressData: { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey },
      value: 10n, tokenData,
    });
    const tree = new UTXOMerkletree();
    tree.insert(nToHex(note.hash));
    const proof = tree.merkleProof(0);
    const summary: PlanSummary = { tokenAddress: USDC, inputTotal: 10n, outputs: [], changeValue: 0n };
    return {
      inputs: [{ random: note.random, value: 10n, position: 0, merkleProofElements: proof.elements.map((e) => BigInt(`0x${e}`)) }],
      outputs: [
        { receiverAddress: recipient.railgunAddress, value: 6n },
        { receiverAddress: sender.railgunAddress, value: 4n },
      ],
      tokenAddress: USDC,
      sender: {
        masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey, viewingPrivateKey: sender.viewingPrivateKey,
        nullifyingKey: sender.nullifyingKey, spendingPublicKey: sender.spendingPublicKey, senderAddress: sender.railgunAddress,
      },
      signer, summary, merkleRoot: BigInt(`0x${tree.root()}`), treeNumber: 0, chainType: 0, chainId: 31337,
    };
  }

  it('orchestrates witness → resolve(shape) → prove → calldata, returning a valid handle', async () => {
    let seenShape: CircuitShape | undefined;
    let seenInputs: unknown;
    let seenArtifacts: ArtifactSet | undefined;
    const progress: number[] = [];

    const artifacts: ArtifactSource = { resolve: async (shape) => { seenShape = shape; return DUMMY_ARTIFACTS; } };
    const prover: ProverAdapter = {
      prove: async (inputs, art, opts) => { seenInputs = inputs; seenArtifacts = art; opts?.onProgress?.({ phase: 'proving', fraction: 1 }); return DUMMY_PROOF; },
      verify: async () => true,
      close: async () => {},
    };

    const handle = await prove(
      { witness: await witnessParams(), artifacts, prover, poolAddress: POOL, expiresAt: 123 },
      { onProgress: (p) => progress.push(p.fraction) },
    );

    // Artifacts resolved for the assembled shape (1 input, 2 outputs).
    expect(seenShape).toEqual({ nullifiers: 1, commitments: 2 });
    // Prover got the formatted railgun inputs + the resolved artifacts + forwarded progress.
    expect(seenArtifacts).toBe(DUMMY_ARTIFACTS);
    expect((seenInputs as { npkOut: bigint[] }).npkOut).toHaveLength(2);
    expect(progress).toEqual([1]);

    // The handle owns calldata to the pool; it decodes back to the proved nullifiers/commitments.
    expect(handle.isValid).toBe(true);
    expect(handle.expiresAt).toBe(123);
    const calldata = handle.toTransactCalldata();
    expect(calldata.to).toBe(POOL);
    const [decoded] = decodeTransact(calldata.data);
    expect(decoded!.nullifiers).toHaveLength(1);
    expect(decoded!.commitments).toHaveLength(2);
    expect(decoded!.boundParams.treeNumber).toBe(0);
    expect(decoded!.commitmentCiphertexts).toHaveLength(2);
  });

  it('invalidate() makes the handle refuse calldata', async () => {
    const artifacts: ArtifactSource = { resolve: async () => DUMMY_ARTIFACTS };
    const prover: ProverAdapter = { prove: async () => DUMMY_PROOF, verify: async () => true, close: async () => {} };
    const handle = await prove({ witness: await witnessParams(), artifacts, prover, poolAddress: POOL });

    expect(handle.isValid).toBe(true);
    handle.invalidate();
    expect(handle.isValid).toBe(false);
    expect(() => handle.toTransactCalldata()).toThrow(/invalidated/);
  });

  it('exposes the proved Transaction struct for wrapper embedding, then refuses it once invalidated', async () => {
    // WHY: cross-chain unshield + yield hand-encode the proved Transaction inside a wrapper call
    // (atomicCrossChainUnshield / lendAndShield) — they need the struct, not just transact() calldata.
    const artifacts: ArtifactSource = { resolve: async () => DUMMY_ARTIFACTS };
    const prover: ProverAdapter = { prove: async () => DUMMY_PROOF, verify: async () => true, close: async () => {} };
    const handle = await prove({ witness: await witnessParams(), artifacts, prover, poolAddress: POOL });

    const tx = handle.toTransactionData();
    // Re-serializing the exposed struct reproduces the handle's own transact() calldata (self-consistent).
    expect(buildTransactCalldata([tx], POOL).data).toBe(handle.toTransactCalldata().data);
    // The ABI tuple is embeddable in a wrapper's Transaction arg (arity: proof, root, nulls, cmts, bound, preimage).
    expect(transactionToTuple(tx)).toHaveLength(6);

    handle.invalidate();
    expect(() => handle.toTransactionData()).toThrow(/invalidated/);
  });
});
