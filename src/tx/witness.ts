// ABOUTME: buildWitness (SPEC §4.6) — assembles the Railgun transfer circuit inputs from full input
// ABOUTME: notes + merkle proofs + output notes + the SpendSigner EdDSA signature. Matches stock transaction.ts.

import {
  poseidon,
  TransactNote,
  hashBoundParamsV2,
  getTokenDataERC20,
  getTokenDataHash,
  decodeAddress,
} from '../core/index';
import { createTransferNote, encryptNoteToReceiver, type CommitmentCiphertextV2 } from '../sync/index';
import type { SpendSigner } from '../wallet/index';
import type { PlanSummary } from './index';
import type { CircuitShape } from '../prover/index';
import type { TransactionBoundParams } from './serialize';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as const;

const hx = (s: string): string => (s.startsWith('0x') ? s : `0x${s}`);
const bytesToHex = (b: Uint8Array): string => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
const hexToBigInt = (s: string): bigint => BigInt(hx(s));

/** A note being spent: its random/value, tree position (leaf index), and merkle path elements. */
export interface WitnessInput {
  readonly random: string;
  readonly value: bigint;
  readonly position: number;
  readonly merkleProofElements: readonly bigint[];
}

/** An output note to create, in emit order (broadcaster fee FIRST per Spike 2, then recipients, then change). */
export interface WitnessOutputRequest {
  readonly receiverAddress: string; // 0zk address
  readonly value: bigint;
  readonly memo?: string;
}

/** The spending wallet's key material for witness assembly (spend key stays in the SpendSigner). */
export interface WitnessSenderContext {
  readonly masterPublicKey: bigint;
  readonly viewingPublicKey: Uint8Array;
  readonly viewingPrivateKey: Uint8Array;
  readonly nullifyingKey: bigint;
  readonly spendingPublicKey: readonly [bigint, bigint];
  readonly senderAddress: string; // sender's own 0zk (senderAddressData on outputs)
}

export interface BuildWitnessParams {
  readonly inputs: readonly WitnessInput[];
  readonly outputs: readonly WitnessOutputRequest[];
  readonly tokenAddress: `0x${string}`;
  readonly sender: WitnessSenderContext;
  readonly signer: SpendSigner;
  /** The plan summary — forwarded to the signer as the fully-bound intent context. */
  readonly summary: PlanSummary;
  readonly merkleRoot: bigint;
  readonly treeNumber: number;
  readonly chainType: number;
  readonly chainId: number;
  readonly minGasPrice?: bigint;
  readonly unshield?: number;
  readonly adaptContract?: `0x${string}`;
  readonly adaptParams?: `0x${string}`;
}

/** The flattened circuit inputs snarkjs consumes (`FormattedCircuitInputsRailgun`). */
export interface FormattedCircuitInputs {
  readonly merkleRoot: bigint;
  readonly boundParamsHash: bigint;
  readonly nullifiers: bigint[];
  readonly commitmentsOut: bigint[];
  readonly token: bigint;
  readonly publicKey: [bigint, bigint];
  readonly signature: [bigint, bigint, bigint];
  readonly randomIn: bigint[];
  readonly valueIn: bigint[];
  readonly pathElements: bigint[];
  readonly leavesIndices: bigint[];
  readonly nullifyingKey: bigint;
  readonly npkOut: bigint[];
  readonly valueOut: bigint[];
}

export interface BuiltWitness {
  readonly formattedInputs: FormattedCircuitInputs;
  readonly publicInputs: {
    readonly merkleRoot: bigint;
    readonly boundParamsHash: bigint;
    readonly nullifiers: bigint[];
    readonly commitmentsOut: bigint[];
  };
  /** The full bound params (with output ciphertexts) — feeds `buildTransactCalldata`. */
  readonly boundParams: TransactionBoundParams;
  readonly shape: CircuitShape;
}

// 1 byte chainType (top) + 7 bytes chainID → the uint64 "full network id" the contract binds.
function fullNetworkID(chainType: number, chainId: number): bigint {
  return (BigInt(chainType) << 56n) | BigInt(chainId);
}

/**
 * Assemble the transfer circuit witness. Creates the output notes (encrypting each to its receiver),
 * computes nullifiers/commitments, the bound-params hash, and requests the EdDSA spend-auth signature
 * over `poseidon([merkleRoot, boundParamsHash, ...nullifiers, ...commitmentsOut])`. The output order is
 * caller-controlled and MUST be fee-first. Correctness of the circuit-field format is validated by the
 * tx chain differential; this builds the invariants (nullifiers, commitments, signature, hash) exactly.
 */
export async function buildWitness(params: BuildWitnessParams): Promise<BuiltWitness> {
  const tokenData = getTokenDataERC20(params.tokenAddress);
  const tokenHash = getTokenDataHash(tokenData);
  const senderAddressData = decodeAddress(params.sender.senderAddress);

  // Output notes — create + encrypt each to its receiver (reuses the note ECIES send path).
  const outNotes: TransactNote[] = [];
  const ciphertexts: CommitmentCiphertextV2[] = [];
  for (const out of params.outputs) {
    const receiverAddressData = decodeAddress(out.receiverAddress);
    const note = createTransferNote({
      receiverAddressData,
      senderAddressData,
      value: out.value,
      tokenData,
      ...(out.memo !== undefined ? { memoText: out.memo } : {}),
    });
    const ciphertext = await encryptNoteToReceiver(
      note,
      {
        masterPublicKey: params.sender.masterPublicKey,
        viewingPublicKey: params.sender.viewingPublicKey,
        viewingPrivateKey: params.sender.viewingPrivateKey,
      },
      receiverAddressData.viewingPublicKey,
    );
    outNotes.push(note);
    ciphertexts.push(ciphertext);
  }

  const npkOut = outNotes.map((n) => n.notePublicKey);
  const valueOut = outNotes.map((n) => n.value);
  const commitmentsOut = outNotes.map((n) => n.hash);
  const nullifiers = params.inputs.map((i) => TransactNote.getNullifier(params.sender.nullifyingKey, i.position));

  const chainID = fullNetworkID(params.chainType, params.chainId);
  const minGasPrice = params.minGasPrice ?? 0n;
  const unshield = params.unshield ?? 0;
  const adaptContract = params.adaptContract ?? ZERO_ADDRESS;
  const adaptParams = params.adaptParams ?? ZERO_BYTES32;

  // Bound-params hash — the abi.encode struct must match the contract's Verifier.hashBoundParams.
  const boundParamsForHash = {
    treeNumber: params.treeNumber,
    minGasPrice,
    unshield,
    chainID,
    adaptContract,
    adaptParams,
    commitmentCiphertext: ciphertexts.map((ct) => ({
      ciphertext: ct.ciphertext.map(hx),
      blindedSenderViewingKey: bytesToHex(ct.blindedSenderViewingKey),
      blindedReceiverViewingKey: bytesToHex(ct.blindedReceiverViewingKey),
      annotationData: hx(ct.annotationData),
      memo: hx(ct.memo),
    })),
  };
  const boundParamsHash = hashBoundParamsV2(boundParamsForHash as unknown as Parameters<typeof hashBoundParamsV2>[0]);

  // Spend-auth signature over the pinned intent digest.
  const message = poseidon([params.merkleRoot, boundParamsHash, ...nullifiers, ...commitmentsOut]);
  const boundParamsContext = { treeNumber: params.treeNumber, minGasPrice, unshield, chainID, adaptContract, adaptParams };
  const [signature] = await params.signer.signBatch([
    { message, context: { nullifiers, commitmentsOut, merkleRoot: params.merkleRoot, boundParams: boundParamsContext, summary: params.summary } },
  ]);
  if (signature === undefined) {
    throw new Error('buildWitness: signer returned no signature');
  }

  const formattedInputs: FormattedCircuitInputs = {
    merkleRoot: params.merkleRoot,
    boundParamsHash,
    nullifiers,
    commitmentsOut,
    token: hexToBigInt(tokenHash),
    publicKey: [params.sender.spendingPublicKey[0], params.sender.spendingPublicKey[1]],
    signature: [signature.R8[0], signature.R8[1], signature.S],
    randomIn: params.inputs.map((i) => hexToBigInt(i.random)),
    valueIn: params.inputs.map((i) => i.value),
    pathElements: params.inputs.flatMap((i) => [...i.merkleProofElements]),
    leavesIndices: params.inputs.map((i) => BigInt(i.position)),
    nullifyingKey: params.sender.nullifyingKey,
    npkOut,
    valueOut,
  };

  const boundParams: TransactionBoundParams = {
    treeNumber: params.treeNumber,
    minGasPrice,
    unshield,
    chainID,
    adaptContract,
    adaptParams,
    commitmentCiphertext: ciphertexts,
  };

  return {
    formattedInputs,
    publicInputs: { merkleRoot: params.merkleRoot, boundParamsHash, nullifiers, commitmentsOut },
    boundParams,
    shape: { nullifiers: params.inputs.length, commitments: params.outputs.length },
  };
}
