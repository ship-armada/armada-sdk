// ABOUTME: View-only identity derivation (SPEC §4.2.2) — viewing capability without spend. The
// ABOUTME: integrator reporting primitive: one view-only wallet per account = one disclosure boundary.

import { poseidon, getPublicViewingKey, WalletNode, encodeAddress } from '../core/index';

export interface ViewOnlyIdentity {
  readonly viewingPublicKey: Uint8Array;
  readonly nullifyingKey: bigint;
  readonly masterPublicKey: bigint;
  readonly shieldedAddress: string;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Reconstruct the view-only identity from the viewing PRIVATE key + the spending PUBLIC key — full
 * scan/balance/disclosure capability, NO spend. A view-only wallet has no `SpendSigner`; any
 * spend-path call throws `NoSpendCapabilityError` (enforced by the wallet object). Shared-viewing-key
 * irrevocability is a documented product constraint (SPEC §4.2.2).
 */
export async function deriveViewOnlyIdentity(
  viewingPrivateKey: Uint8Array,
  spendingPublicKey: [bigint, bigint],
): Promise<ViewOnlyIdentity> {
  // nullifyingKey = poseidon([viewingPrivateKey]) — matches WalletNode.getNullifyingKey.
  const nullifyingKey = poseidon([BigInt('0x' + bytesToHex(viewingPrivateKey))]);
  const viewingPublicKey = await getPublicViewingKey(viewingPrivateKey);
  const masterPublicKey = WalletNode.getMasterPublicKey(spendingPublicKey, nullifyingKey);
  const shieldedAddress = encodeAddress({ masterPublicKey, viewingPublicKey });
  return { viewingPublicKey, nullifyingKey, masterPublicKey, shieldedAddress };
}
