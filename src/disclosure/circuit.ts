// ABOUTME: Disclosure circuit adapter (ADR-0020) — formats the witness for NullifierDisclosure.circom,
// ABOUTME: computes its five public signals. The Node artifact loader lives in `@armada/sdk/node`.

import { poseidon, signEDDSA } from '../core/index';

/** The circuit's public inputs, in the order the proof exposes them. */
export const DISCLOSURE_PUBLIC_SIGNAL_NAMES = [
  'statementHash',
  'masterPublicKey',
  'nullifier',
  'treeNumber',
  'leafIndex',
] as const;

/** The full witness the circuit consumes (public inputs + private spending key, keys and signature). */
export interface DisclosureCircuitInput {
  readonly statementHash: bigint;
  readonly masterPublicKey: bigint;
  readonly nullifier: bigint;
  readonly treeNumber: bigint;
  readonly leafIndex: bigint;
  readonly spendingPublicKey: readonly [bigint, bigint];
  readonly nullifyingKey: bigint;
  readonly signature: readonly [bigint, bigint, bigint];
}

/** The wallet keys needed to produce a disclosure witness. */
export interface DisclosureSigningKeys {
  readonly spendingPublicKey: readonly [bigint, bigint];
  readonly spendingPrivateKey: Uint8Array;
  readonly nullifyingKey: bigint;
  readonly masterPublicKey: bigint;
}

/**
 * Build a disclosure witness for one nullifier. The nullifier derives from the nullifying key and the
 * leaf index; the signed message is `Poseidon(statementHash, M, nullifier, treeNumber, leafIndex)`;
 * the spending key signs it (EdDSA/Poseidon over BabyJubJub).
 */
export function formatDisclosureInput(
  keys: DisclosureSigningKeys,
  statementHash: bigint,
  treeNumber: number,
  leafIndex: number,
): DisclosureCircuitInput {
  const nullifier = poseidon([keys.nullifyingKey, BigInt(leafIndex)]);
  const message = poseidon([
    statementHash,
    keys.masterPublicKey,
    nullifier,
    BigInt(treeNumber),
    BigInt(leafIndex),
  ]);
  const sig = signEDDSA(keys.spendingPrivateKey, message);
  return {
    statementHash,
    masterPublicKey: keys.masterPublicKey,
    nullifier,
    treeNumber: BigInt(treeNumber),
    leafIndex: BigInt(leafIndex),
    spendingPublicKey: [keys.spendingPublicKey[0], keys.spendingPublicKey[1]],
    nullifyingKey: keys.nullifyingKey,
    signature: [sig.R8[0], sig.R8[1], sig.S],
  };
}

/** The five public signals of a disclosure proof, in circuit order. */
export function disclosurePublicSignals(input: DisclosureCircuitInput): bigint[] {
  return [input.statementHash, input.masterPublicKey, input.nullifier, input.treeNumber, input.leafIndex];
}

