// ABOUTME: Canonical keyset derivation from a rootSecret (SPEC §4.2, decision 6) — the BIP-32
// ABOUTME: mnemonic-detour path, retained to preserve testnet identity. Verified vs keyset-vectors.json.

import { Mnemonic, deriveNodes, WalletNode, encodeAddress } from '../core/index';
import { InvalidKeyMaterialError } from '../errors';

export interface Keyset {
  readonly spendingPublicKey: [bigint, bigint];
  readonly spendingPrivateKey: Uint8Array;
  readonly viewingPublicKey: Uint8Array;
  readonly viewingPrivateKey: Uint8Array;
  readonly nullifyingKey: bigint;
  readonly masterPublicKey: bigint;
  readonly shieldedAddress: string;
}

// Browser-safe (no node Buffer) — core stays bundlable without polyfills.
function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * BIP-39 mnemonic (+ derivation index) → full canonical keyset. Path: BIP-32 wallet nodes →
 * spending/viewing keypairs → nullifyingKey → masterPublicKey → 0zk address. Byte-identical to the
 * stock engine's `createWalletFromMnemonic`. The relayer's mnemonic-provisioned wallet uses this.
 */
export async function deriveKeysetFromMnemonic(mnemonic: string, index = 0): Promise<Keyset> {
  // Reject a mnemonic that fails the BIP-39 checksum — a typo would otherwise silently derive a
  // different (empty) wallet. `deriveKeyset` generates its mnemonic via fromEntropy, so it always passes.
  if (!Mnemonic.validate(mnemonic)) {
    throw new InvalidKeyMaterialError('deriveKeysetFromMnemonic: invalid BIP-39 mnemonic (checksum failed)');
  }
  const nodes = deriveNodes(mnemonic, index);
  const spending = nodes.spending.getSpendingKeyPair();
  const viewing = await nodes.viewing.getViewingKeyPair();
  const nullifyingKey = await nodes.viewing.getNullifyingKey();
  const masterPublicKey = WalletNode.getMasterPublicKey(spending.pubkey, nullifyingKey);
  const shieldedAddress = encodeAddress({ masterPublicKey, viewingPublicKey: viewing.pubkey });
  return {
    spendingPublicKey: spending.pubkey,
    spendingPrivateKey: spending.privateKey,
    viewingPublicKey: viewing.pubkey,
    viewingPrivateKey: viewing.privateKey,
    nullifyingKey,
    masterPublicKey,
    shieldedAddress,
  };
}

/**
 * rootSecret (32 bytes) → full canonical keyset via the entropy → BIP-39 mnemonic detour (SPEC §4.2,
 * decision 6). Verified vs keyset-vectors.json (Phase 0 Spike 1); closes the deferred keyset vector.
 */
export async function deriveKeyset(rootSecret: Uint8Array): Promise<Keyset> {
  if (rootSecret.length !== 32) {
    throw new InvalidKeyMaterialError(`deriveKeyset: expected 32-byte rootSecret, got ${rootSecret.length}`);
  }
  return deriveKeysetFromMnemonic(Mnemonic.fromEntropy(bytesToHex(rootSecret)), 0);
}
