// ABOUTME: prove() orchestration + ProofHandle (SPEC §4.6) — witness → artifacts → Groth16 proof →
// ABOUTME: transact() calldata, wrapped in a handle that owns its calldata (no populate-time re-matching).

import { buildWitness, type BuildWitnessParams } from './witness';
import { buildTransactCalldata, type TransactionData } from './serialize';
import type { ArtifactSource, ProverAdapter, ProveOptions } from '../prover/index';
import type { ProofHandle, TransactCalldata } from './index';
import { ProofHandleInvalidatedError, ProofExpiredError } from '../errors';

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
 * arguments (killing the stock SDK's silent proof-cache contract). It refuses to hand out calldata once
 * `invalidate()`d OR past its `expiresAt` policy TTL (SPEC §4.6): a proof stays valid on-chain until an
 * input is nullified, but a signer/app policy can bound the window, and now the handle actually enforces it.
 */
class ProvedTransaction implements ProofHandle {
  private valid = true;
  readonly expiresAt?: number;

  constructor(
    private readonly calldata: TransactCalldata,
    private readonly transaction: TransactionData,
    expiresAt: number | undefined,
  ) {
    if (expiresAt !== undefined) {
      this.expiresAt = expiresAt;
    }
  }

  private get expired(): boolean {
    return this.expiresAt !== undefined && Date.now() > this.expiresAt;
  }

  private assertUsable(): void {
    if (!this.valid) {
      throw new ProofHandleInvalidatedError('ProofHandle: invalidated — re-plan and re-prove');
    }
    if (this.expired) {
      throw new ProofExpiredError('ProofHandle: expired past its TTL — re-plan and re-prove');
    }
  }

  toTransactCalldata(): TransactCalldata {
    this.assertUsable();
    return this.calldata;
  }

  toTransactionData(): TransactionData {
    this.assertUsable();
    return this.transaction;
  }

  invalidate(): void {
    this.valid = false;
  }

  get isValid(): boolean {
    return this.valid && !this.expired;
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

  return new ProvedTransaction(calldata, transaction, params.expiresAt);
}
