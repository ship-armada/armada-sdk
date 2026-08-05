// ABOUTME: adaptParams binding encoders (SPEC §4.6, fixes #399) — byte-exact ports of the deployed
// ABOUTME: CCTPBindingLib + YieldAdaptParams keccak256 commitments. One-way, so it's encode + verify.

import { keccak256, toUtf8Bytes, AbiCoder } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();

/**
 * `boundParams.adaptParams` is a SNARK public input (committed by the proof), so binding plaintext
 * destination arguments into it makes them proof-bound with no circuit change. The commitment is a
 * keccak256 HASH — not reversible — so a decoder cannot recover the fields; a verifier that already
 * holds the candidate fields (from the wrapper calldata) re-derives and compares.
 */

/** Versioned domain tag — CCTPBindingLib.DOMAIN_TAG = keccak256("ArmadaCCTPUnshield.v1"). */
export const CCTP_UNSHIELD_DOMAIN_TAG = keccak256(toUtf8Bytes('ArmadaCCTPUnshield.v1'));

function toBytes32(n: bigint): string {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

/** Bind a cross-chain-unshield destination tuple (matches CCTPBindingLib.encode). */
export function encodeCctpBinding(
  recipient: string,
  destinationDomain: number,
  maxFee: bigint,
): `0x${string}` {
  return keccak256(
    coder.encode(
      ['bytes32', 'address', 'uint32', 'uint256'],
      [CCTP_UNSHIELD_DOMAIN_TAG, recipient, destinationDomain, maxFee],
    ),
  ) as `0x${string}`;
}

/** True when the arguments hash to the proof-bound adaptParams (matches CCTPBindingLib.verify). */
export function verifyCctpBinding(
  adaptParams: string,
  recipient: string,
  destinationDomain: number,
  maxFee: bigint,
): boolean {
  return adaptParams.toLowerCase() === encodeCctpBinding(recipient, destinationDomain, maxFee).toLowerCase();
}

/** Bind the re-shield destination for a yield deposit/lend (matches YieldAdaptParams.encode/3). */
export function encodeYieldDepositBinding(
  npk: bigint,
  encryptedBundle: readonly [string, string, string],
  shieldKey: string,
): `0x${string}` {
  return keccak256(
    coder.encode(['bytes32', 'bytes32[3]', 'bytes32'], [toBytes32(npk), encryptedBundle, shieldKey]),
  ) as `0x${string}`;
}

export function verifyYieldDepositBinding(
  adaptParams: string,
  npk: bigint,
  encryptedBundle: readonly [string, string, string],
  shieldKey: string,
): boolean {
  return adaptParams.toLowerCase() === encodeYieldDepositBinding(npk, encryptedBundle, shieldKey).toLowerCase();
}

/**
 * Bind the user's re-shield destination + the broadcaster fee-shield for a yield redeem/withdraw
 * (matches YieldAdaptParams.encode/7). Produces a DIFFERENT commitment than the deposit overload.
 */
export function encodeYieldRedeemBinding(
  npk: bigint,
  encryptedBundle: readonly [string, string, string],
  shieldKey: string,
  feeNpk: bigint,
  feeEncryptedBundle: readonly [string, string, string],
  feeShieldKey: string,
  feeAmount: bigint,
): `0x${string}` {
  return keccak256(
    coder.encode(
      ['bytes32', 'bytes32[3]', 'bytes32', 'bytes32', 'bytes32[3]', 'bytes32', 'uint256'],
      [toBytes32(npk), encryptedBundle, shieldKey, toBytes32(feeNpk), feeEncryptedBundle, feeShieldKey, feeAmount],
    ),
  ) as `0x${string}`;
}

export function verifyYieldRedeemBinding(
  adaptParams: string,
  npk: bigint,
  encryptedBundle: readonly [string, string, string],
  shieldKey: string,
  feeNpk: bigint,
  feeEncryptedBundle: readonly [string, string, string],
  feeShieldKey: string,
  feeAmount: bigint,
): boolean {
  return (
    adaptParams.toLowerCase() ===
    encodeYieldRedeemBinding(npk, encryptedBundle, shieldKey, feeNpk, feeEncryptedBundle, feeShieldKey, feeAmount).toLowerCase()
  );
}
