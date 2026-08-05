// ABOUTME: prove() orchestration + ProofHandle (SPEC §4.6) — witness → artifacts → Groth16 proof →
// ABOUTME: transact() calldata, wrapped in a handle that owns its calldata (no populate-time re-matching).

import { buildWitness, type BuildWitnessParams } from './witness';
import { buildTransactCalldata, type TransactionData } from './serialize';
import type { ArtifactSource, ProverAdapter, ProveOptions } from '../prover/index';
import type { ProofHandle, TransactCalldata } from './index';

export interface ProveParams {
  /** The transfer witness to assemble + prove. */
  readonly witness: BuildWitnessParams;
  /** Resolves the compiled artifacts for the witness's circuit shape. */
  readonly artifacts: ArtifactSource;
  readonly prover: ProverAdapter;
  readonly poolAddress: `0x${string}`;
  /** Present only for unshields (passed through to the serialized Transaction). */
  readonly unshieldPreimage?: TransactionData['unshieldPreimage'];
  /** Optional signer/app policy hint — NOT an on-chain expiry (a proof stays valid until an input is nullified). */
  readonly expiresAt?: number;
}

/**
 * A proved transaction. It owns the exact calldata it proves — `toTransactCalldata()` never re-derives
 * arguments (killing the stock SDK's silent proof-cache contract). Once `invalidate()`d it refuses to
 * hand out calldata.
 */
class ProvedTransaction implements ProofHandle {
  private valid = true;
  readonly expiresAt?: number;

  constructor(
    private readonly calldata: TransactCalldata,
    expiresAt: number | undefined,
  ) {
    if (expiresAt !== undefined) {
      this.expiresAt = expiresAt;
    }
  }

  toTransactCalldata(): TransactCalldata {
    if (!this.valid) {
      throw new Error('ProofHandle: invalidated — re-plan and re-prove');
    }
    return this.calldata;
  }

  invalidate(): void {
    this.valid = false;
  }

  get isValid(): boolean {
    return this.valid;
  }
}

/**
 * Assemble the witness, resolve the shape's artifacts, generate the Groth16 proof off the caller's
 * `ProverAdapter`, and serialize the transact() calldata — returned as an inspectable `ProofHandle`.
 */
export async function prove(params: ProveParams, options?: ProveOptions): Promise<ProofHandle> {
  const witness = await buildWitness(params.witness);
  const artifactSet = await params.artifacts.resolve(witness.shape);
  const proof = await params.prover.prove(witness.formattedInputs, artifactSet, options);

  const transaction: TransactionData = {
    proof,
    merkleRoot: witness.publicInputs.merkleRoot,
    nullifiers: witness.publicInputs.nullifiers,
    commitments: witness.publicInputs.commitmentsOut,
    boundParams: witness.boundParams,
    ...(params.unshieldPreimage ? { unshieldPreimage: params.unshieldPreimage } : {}),
  };
  const calldata = buildTransactCalldata([transaction], params.poolAddress);

  return new ProvedTransaction(calldata, params.expiresAt);
}
