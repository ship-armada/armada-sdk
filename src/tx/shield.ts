// ABOUTME: Shield-request builder (SPEC §4.6, #410) — constructs the ShieldRequest struct for
// ABOUTME: privacyPool.shield(): a shielded ERC20 deposit note addressed to a 0zk recipient.

import { ShieldNoteERC20, decodeAddress, type TokenData } from '../core/index';

export interface ShieldRequestInput {
  readonly railgunAddress: string;
  readonly amount: bigint;
  readonly tokenAddress: string;
}

/** On-chain `ShieldRequest` — plaintext preimage (npk/token/value) + the shield ECIES ciphertext. */
export interface ShieldRequest {
  readonly preimage: { readonly npk: string; readonly token: TokenData; readonly value: bigint };
  readonly ciphertext: { readonly encryptedBundle: readonly [string, string, string]; readonly shieldKey: string };
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  let hex = '';
  for (const b of buf) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** An ephemeral 32-byte shield private key. The signature-derived (`RAILGUN_SHIELD`) variant is separate. */
export function generateShieldPrivateKey(): Uint8Array {
  const key = new Uint8Array(32);
  globalThis.crypto.getRandomValues(key);
  return key;
}

/**
 * Build a shield request for `privacyPool.shield([request], integrator)` — a shielded deposit of
 * `amount` of `tokenAddress` to `railgunAddress`. `random` (returned) is the note's 16-byte randomness,
 * recoverable by the recipient's viewing key via the shield ECIES bundle.
 */
export async function buildShieldRequest(
  input: ShieldRequestInput,
  shieldPrivateKey: Uint8Array,
): Promise<{ shieldRequest: ShieldRequest; random: string }> {
  const { masterPublicKey, viewingPublicKey } = decodeAddress(input.railgunAddress);
  const random = randomHex(16);
  const note = new ShieldNoteERC20(masterPublicKey, random, input.amount, input.tokenAddress);
  const shieldRequest = (await note.serialize(shieldPrivateKey, viewingPublicKey)) as unknown as ShieldRequest;
  return { shieldRequest, random };
}
