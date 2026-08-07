// ABOUTME: transact() calldata serializer (SPEC §4.6) — the inverse of decodeTransact. Encodes proved
// ABOUTME: Transaction structs (SnarkProof with the on-chain G2 coordinate swap) into transact() calldata.

import { Interface } from 'ethers';
import { TRANSACT_ABI } from './decode';
import type { TransactCalldata } from './index';
import type { Groth16Proof } from '../prover/index';
import type { CommitmentCiphertextV2 } from '../sync/index';

const iface = new Interface(TRANSACT_ABI as unknown as string[]);

const b32 = (n: bigint): string => `0x${n.toString(16).padStart(64, '0')}`;
const hx = (s: string): string => (s.startsWith('0x') ? s : `0x${s}`);
const bytesToHex = (b: Uint8Array): string => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;

/** The bound params carried on a Transaction (with the output note ciphertexts). */
export interface TransactionBoundParams {
  readonly treeNumber: number;
  readonly minGasPrice: bigint;
  readonly unshield: number;
  readonly chainID: bigint;
  readonly adaptContract: `0x${string}`;
  readonly adaptParams: `0x${string}`;
  readonly commitmentCiphertext: readonly CommitmentCiphertextV2[];
}

/** One proved Transaction ready for calldata serialization. */
export interface TransactionData {
  readonly proof: Groth16Proof;
  readonly merkleRoot: bigint;
  readonly nullifiers: readonly bigint[];
  readonly commitments: readonly bigint[];
  readonly boundParams: TransactionBoundParams;
  /** Present only for unshields (UnshieldType != NONE). */
  readonly unshieldPreimage?: {
    readonly npk: bigint;
    readonly tokenType: number;
    readonly tokenAddress: `0x${string}`;
    readonly tokenSubID: bigint;
    readonly value: bigint;
  };
}

const ZERO_PREIMAGE = [b32(0n), [0, '0x0000000000000000000000000000000000000000', 0n], 0n];

function ciphertextTuple(ct: CommitmentCiphertextV2): unknown[] {
  return [
    ct.ciphertext.map(hx),
    bytesToHex(ct.blindedSenderViewingKey),
    bytesToHex(ct.blindedReceiverViewingKey),
    hx(ct.annotationData),
    hx(ct.memo),
  ];
}

/**
 * SnarkProof struct from a Groth16Proof, applying the on-chain G2 coordinate swap. snarkjs emits the
 * G2 point `b` with each field-element pair in [c0, c1] order; the solidity pairing check expects them
 * reversed ([c1, c0]). Without the swap the proof will not verify on-chain.
 */
function proofTuple(p: Groth16Proof): unknown[] {
  return [
    [BigInt(p.a[0]), BigInt(p.a[1])],
    [
      [BigInt(p.b[0][1]), BigInt(p.b[0][0])], // b.x swapped
      [BigInt(p.b[1][1]), BigInt(p.b[1][0])], // b.y swapped
    ],
    [BigInt(p.c[0]), BigInt(p.c[1])],
  ];
}

/**
 * The on-chain `Transaction` struct as an ABI positional tuple (proof G2-swapped, fields b32-encoded).
 * Exposed so consumers can embed a proved transaction inside a WRAPPER call (e.g.
 * `atomicCrossChainUnshield(transaction, ...)`, `lendAndShield(transaction, ...)`) via
 * `Interface.encodeFunctionData` — without re-deriving the swap/encoding. For a bare `transact()` use
 * `buildTransactCalldata` instead.
 */
export function transactionToTuple(tx: TransactionData): unknown[] {
  const bp = tx.boundParams;
  const preimage = tx.unshieldPreimage
    ? [
        b32(tx.unshieldPreimage.npk),
        [tx.unshieldPreimage.tokenType, tx.unshieldPreimage.tokenAddress, tx.unshieldPreimage.tokenSubID],
        tx.unshieldPreimage.value,
      ]
    : ZERO_PREIMAGE;
  return [
    proofTuple(tx.proof),
    b32(tx.merkleRoot),
    tx.nullifiers.map(b32),
    tx.commitments.map(b32),
    [bp.treeNumber, bp.minGasPrice, bp.unshield, bp.chainID, bp.adaptContract, bp.adaptParams, bp.commitmentCiphertext.map(ciphertextTuple)],
    preimage,
  ];
}

/**
 * Serialize proved transactions into `transact(Transaction[])` calldata. `to` is the pool address;
 * `value` is 0 (a shielded transaction carries no native value).
 */
export function buildTransactCalldata(transactions: readonly TransactionData[], poolAddress: `0x${string}`): TransactCalldata {
  const data = iface.encodeFunctionData('transact', [transactions.map(transactionToTuple)]) as `0x${string}`;
  return { to: poolAddress, data, value: 0n };
}
