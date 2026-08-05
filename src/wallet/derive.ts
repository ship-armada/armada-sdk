// ABOUTME: Canonical keyset derivation from a rootSecret (SPEC §4.2, decision 6) — the BIP-32
// ABOUTME: mnemonic-detour path, retained to preserve testnet identity. Verified vs keyset-vectors.json.

import { Mnemonic, deriveNodes, WalletNode, encodeAddress } from '../core/index';

export interface Keyset {
  readonly spendingPublicKey: [bigint, bigint];
  readonly spendingPrivateKey: Uint8Array;
  readonly viewingPublicKey: Uint8Array;
  readonly viewingPrivateKey: Uint8Array;
  readonly nullifyingKey: bigint;
  readonly masterPublicKey: bigint;
  readonly railgunAddress: string;
}

// Browser-safe (no node Buffer) — core stays bundlable without polyfills.
function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * rootSecret (32 bytes) → full canonical keyset. Path: entropy → BIP-39 mnemonic → BIP-32 wallet
 * nodes → spending/viewing keypairs → nullifyingKey → masterPublicKey → 0zk address. Byte-identical
 * to the stock engine's `createWalletFromMnemonic` (Phase 0 Spike 1); closes the deferred keyset vector.
 */
export async function deriveKeyset(rootSecret: Uint8Array): Promise<Keyset> {
  if (rootSecret.length !== 32) {
    throw new Error(`deriveKeyset: expected 32-byte rootSecret, got ${rootSecret.length}`);
  }
  const mnemonic = Mnemonic.fromEntropy(bytesToHex(rootSecret));
  const nodes = deriveNodes(mnemonic, 0);
  const spending = nodes.spending.getSpendingKeyPair();
  const viewing = await nodes.viewing.getViewingKeyPair();
  const nullifyingKey = await nodes.viewing.getNullifyingKey();
  const masterPublicKey = WalletNode.getMasterPublicKey(spending.pubkey, nullifyingKey);
  const railgunAddress = encodeAddress({ masterPublicKey, viewingPublicKey: viewing.pubkey });
  return {
    spendingPublicKey: spending.pubkey,
    spendingPrivateKey: spending.privateKey,
    viewingPublicKey: viewing.pubkey,
    viewingPrivateKey: viewing.privateKey,
    nullifyingKey,
    masterPublicKey,
    railgunAddress,
  };
}
