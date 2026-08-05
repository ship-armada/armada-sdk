// ABOUTME: Shield-note ownership decryption (SPEC §4.4) — the scan-side counterpart to the transact
// ABOUTME: ECIES. Recovers `random` from a shield's ciphertext and matches npk to claim owned shields.

import { ShieldNote, getSharedSymmetricKey, getTokenDataHash } from '../core/index';
import type { DecodedShieldCommitment } from './event-decoder';
import type { OwnedNote } from './scan-engine';
import type { ReceiverNoteKeys } from './note-crypto';

// Browser-safe hex helpers (core does not re-export ByteUtils).
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function nToHex256(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

/**
 * Try to claim a shield commitment as owned by the wallet. Shields carry a plaintext value/token in
 * the preimage; ownership is proven by ECDH against the ephemeral `shieldKey`: derive the shared key,
 * decrypt `random`, recompute `npk = poseidon(myMasterPublicKey, random)`, and match it to the
 * preimage npk. Returns the owned note (canonical tokenHash + value) or `undefined` if not ours.
 */
export async function tryDecryptShield(
  commitment: DecodedShieldCommitment,
  receiver: ReceiverNoteKeys,
): Promise<OwnedNote | undefined> {
  const sharedKey = await getSharedSymmetricKey(receiver.viewingPrivateKey, hexToBytes(commitment.shieldKey));
  if (sharedKey === undefined) {
    return undefined;
  }

  let random: string;
  try {
    random = ShieldNote.decryptRandom(
      [commitment.encryptedBundle[0], commitment.encryptedBundle[1], commitment.encryptedBundle[2]],
      sharedKey,
    );
  } catch {
    // AES-GCM auth failure — the shield was encrypted to a different receiver.
    return undefined;
  }

  const npk = ShieldNote.getNotePublicKey(receiver.addressData.masterPublicKey, random);
  if (nToHex256(npk) !== commitment.npk) {
    // Shared key decrypted, but the note public key isn't ours — not our shield.
    return undefined;
  }

  return { tokenHash: getTokenDataHash(commitment.tokenData), value: commitment.value, random, notePublicKey: npk };
}
