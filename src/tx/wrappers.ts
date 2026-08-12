// ABOUTME: Wrapper calldata builders (SPEC §4.6) — encode a proved Transaction into the yield /
// ABOUTME: cross-chain-unshield wrapper entry points, so consumers don't hand-roll Interface.encodeFunctionData.

import { Interface } from 'ethers';
import { TRANSACTION_STRUCT } from './decode';
import { transactionToTuple, type TransactionData } from './serialize';
import type { TransactCalldata } from './index';

// The wrapper entry points, byte-exact against the deployed contracts (selectors 0x2bcba06a /
// 0xf2987ad1 / 0x7e220759). Each embeds the on-chain `Transaction` at arg 0.
const WRAPPER_ABI = [
  `function atomicCrossChainUnshield(${TRANSACTION_STRUCT} _transaction, uint32 destinationDomain, address finalRecipient, uint256 maxFee, bytes32 uniqueNonce) returns (uint64)`,
  `function lendAndShield(${TRANSACTION_STRUCT} _transaction, bytes32 _npk, (bytes32[3] encryptedBundle, bytes32 shieldKey) _shieldCiphertext) returns (uint256)`,
  `function redeemAndShield(${TRANSACTION_STRUCT} _transaction, bytes32 _npk, (bytes32[3] encryptedBundle, bytes32 shieldKey) _shieldCiphertext, bytes32 _feeNpk, (bytes32[3] encryptedBundle, bytes32 shieldKey) _feeShieldCiphertext, uint256 _feeAmount) returns (uint256)`,
] as const;

const iface = new Interface(WRAPPER_ABI as unknown as string[]);

/** A shield note's on-chain re-shield ciphertext (matches Globals.ShieldCiphertext). */
export interface ShieldCiphertextArg {
  readonly encryptedBundle: readonly [string, string, string];
  readonly shieldKey: string;
}

const hx = (s: string): string => (s.startsWith('0x') ? s : `0x${s}`);
const b32 = (n: bigint): string => `0x${n.toString(16).padStart(64, '0')}`;
const ctTuple = (c: ShieldCiphertextArg): unknown[] => [c.encryptedBundle.map(hx), hx(c.shieldKey)];

/**
 * `atomicCrossChainUnshield(tx, destinationDomain, finalRecipient, maxFee, uniqueNonce)` — a cross-chain
 * unshield. `to` is the PrivacyPool (the router declares the entry point). The proof must bind
 * `boundParams.adaptParams = encodeCctpBinding(finalRecipient, destinationDomain, maxFee)`.
 */
export function buildAtomicCrossChainUnshieldCalldata(
  tx: TransactionData,
  params: {
    readonly poolAddress: `0x${string}`;
    readonly destinationDomain: number;
    readonly finalRecipient: `0x${string}`;
    readonly maxFee: bigint;
    readonly uniqueNonce: bigint;
  },
): TransactCalldata {
  const data = iface.encodeFunctionData('atomicCrossChainUnshield', [
    transactionToTuple(tx),
    params.destinationDomain,
    params.finalRecipient,
    params.maxFee,
    b32(params.uniqueNonce),
  ]) as `0x${string}`;
  return { to: params.poolAddress, data, value: 0n };
}

/**
 * `lendAndShield(tx, npk, shieldCiphertext)` — unshield USDC into the yield adapter, which deposits to
 * the vault and re-shields vault shares to `npk`. `to` is the ArmadaYieldAdapter. The proof must bind
 * `boundParams.adaptParams = encodeYieldDepositBinding(npk, encryptedBundle, shieldKey)`.
 */
export function buildLendAndShieldCalldata(
  tx: TransactionData,
  params: { readonly adapterAddress: `0x${string}`; readonly npk: bigint; readonly shieldCiphertext: ShieldCiphertextArg },
): TransactCalldata {
  const data = iface.encodeFunctionData('lendAndShield', [
    transactionToTuple(tx),
    b32(params.npk),
    ctTuple(params.shieldCiphertext),
  ]) as `0x${string}`;
  return { to: params.adapterAddress, data, value: 0n };
}

/**
 * `redeemAndShield(tx, npk, shieldCiphertext, feeNpk, feeShieldCiphertext, feeAmount)` — unshield vault
 * shares into the adapter, redeem, and re-shield `(assets − feeAmount)` to `npk` and `feeAmount` to the
 * relayer's `feeNpk`. `to` is the ArmadaYieldAdapter. The proof must bind
 * `boundParams.adaptParams = encodeYieldRedeemBinding(...)` over both notes. (The relayer fee here is
 * contract-side — NOT a broadcaster output inside the Transaction.)
 */
export function buildRedeemAndShieldCalldata(
  tx: TransactionData,
  params: {
    readonly adapterAddress: `0x${string}`;
    readonly npk: bigint;
    readonly shieldCiphertext: ShieldCiphertextArg;
    readonly feeNpk: bigint;
    readonly feeShieldCiphertext: ShieldCiphertextArg;
    readonly feeAmount: bigint;
  },
): TransactCalldata {
  const data = iface.encodeFunctionData('redeemAndShield', [
    transactionToTuple(tx),
    b32(params.npk),
    ctTuple(params.shieldCiphertext),
    b32(params.feeNpk),
    ctTuple(params.feeShieldCiphertext),
    params.feeAmount,
  ]) as `0x${string}`;
  return { to: params.adapterAddress, data, value: 0n };
}
