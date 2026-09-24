// ABOUTME: prove() orchestration + ProofHandle (SPEC §4.6) — witness → artifacts → Groth16 proof →
// ABOUTME: transact() calldata, wrapped in a handle that owns its calldata (no populate-time re-matching).

import { buildWitness, prepareWitness, type BuildWitnessParams, type BuiltWitness } from './witness';
import { buildTransactCalldata, type TransactionData } from './serialize';
import type { ArtifactSource, ProverAdapter, ProveOptions } from '../prover/index';
import type { ProofHandle, TransactCalldata } from './index';
import { ProofHandleInvalidatedError, ProofExpiredError, SignerContractViolationError, InvalidRequestError } from '../errors';

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
  return proveWitness(params, witness, options);
}

/**
 * Prove every group of a multi-group spend (SPEC §4.6) with ONE signing round: each group's witness is
 * assembled up to its intent, the shared `SpendSigner` receives ALL intents in a single `signBatch` call
 * (SPEC §4.2.1 batch semantics — the whole spend is approved as one unit, before any signature is
 * released), then each group is proved in order. Returns one handle per group, in input order. Every
 * group must name the same signer; a signer returning the wrong number of signatures is rejected.
 * `onProgress` spans the whole batch: the fraction runs 0→1 once across all groups.
 */
export async function proveAll(params: readonly ProveParams[], options?: ProveOptions): Promise<ProofHandle[]> {
  const signer = params[0]?.witness.signer;
  if (signer === undefined) return [];
  if (params.some((p) => p.witness.signer !== signer)) {
    throw new InvalidRequestError('proveAll: every group must be signed by the same SpendSigner');
  }

  const prepared = await Promise.all(params.map((p) => prepareWitness(p.witness)));
  const signatures = await signer.signBatch(prepared.map((p) => p.signRequest));
  if (signatures.length !== prepared.length) {
    throw new SignerContractViolationError(
      `proveAll: signer returned ${signatures.length} signatures for ${prepared.length} intents`,
    );
  }

  const handles: ProofHandle[] = [];
  for (let i = 0; i < params.length; i += 1) {
    const witness = prepared[i]!.finalize(signatures[i]!);
    handles.push(await proveWitness(params[i]!, witness, batchProgressOptions(options, i, params.length)));
  }
  return handles;
}

// Group `index` of `count` reports its 0→1 progress as its slice of the whole batch, so a consumer's
// progress runs 0→1 once across all groups instead of restarting for each one.
function batchProgressOptions(options: ProveOptions | undefined, index: number, count: number): ProveOptions | undefined {
  const onProgress = options?.onProgress;
  if (onProgress === undefined) return options;
  return { ...options, onProgress: (p) => onProgress({ ...p, fraction: (index + p.fraction) / count }) };
}

/** Resolve the shape's artifacts, generate the Groth16 proof, and wrap the calldata in a handle. */
async function proveWitness(params: ProveParams, witness: BuiltWitness, options?: ProveOptions): Promise<ProofHandle> {
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
