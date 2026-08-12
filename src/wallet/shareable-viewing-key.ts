// ABOUTME: Shareable viewing-key codec (SPEC §4.2.2) — byte-compatible with Railgun's
// ABOUTME: generateShareableViewingKey: hex(msgpack({ vpriv, spub: packPoint(spendingPublicKey) })).

import msgpack from 'msgpack-lite';
import { Babyjubjub } from '../core/index';
import { InvalidKeyMaterialError } from '../errors';
import { parseHexBytes, assertValidViewingPrivateKey, assertValidBabyJubjubPublicKey } from './keys-validate';

/** The material a shareable viewing key carries: the viewing PRIVATE key + the spending PUBLIC key. */
export interface ShareableViewingKeyMaterial {
  readonly viewingPrivateKey: Uint8Array;
  readonly spendingPublicKey: [bigint, bigint];
}

function toHex32(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex.padStart(64, '0');
}

/** Encode a shareable viewing key — the exact Railgun wire format (interoperable with stock wallets). */
export function encodeShareableViewingKey(material: ShareableViewingKeyMaterial): string {
  const spub = Buffer.from(Babyjubjub.packPoint(material.spendingPublicKey)).toString('hex');
  const encoded = msgpack.encode({ vpriv: toHex32(material.viewingPrivateKey), spub }) as Buffer;
  return encoded.toString('hex');
}

/**
 * Decode a shareable viewing key (Railgun wire format) back to its viewing key + spending public key.
 * Validates all imported material (SPEC §4.2): the payload shape, strict hex, a non-zero 32-byte
 * viewing key, and a spending public key that is on-curve, in the prime-order subgroup, and non-identity.
 * A malformed or crafted key throws `InvalidKeyMaterialError` rather than silently yielding a wrong wallet.
 */
export function decodeShareableViewingKey(shareableViewingKey: string): ShareableViewingKeyMaterial {
  const decoded = msgpack.decode(Buffer.from(shareableViewingKey, 'hex')) as unknown;
  if (
    typeof decoded !== 'object' || decoded === null ||
    typeof (decoded as { vpriv?: unknown }).vpriv !== 'string' ||
    typeof (decoded as { spub?: unknown }).spub !== 'string'
  ) {
    throw new InvalidKeyMaterialError('shareableViewingKey: malformed payload (expected { vpriv, spub } hex strings)');
  }
  const { vpriv, spub } = decoded as { vpriv: string; spub: string };

  const viewingPrivateKey = parseHexBytes(vpriv, 32, 'shareableViewingKey.vpriv');
  assertValidViewingPrivateKey(viewingPrivateKey);

  // `unpackPoint` returns null for an off-curve / malformed packed point; assert narrows it to a point.
  const unpacked = Babyjubjub.unpackPoint(Buffer.from(spub, 'hex')) as [bigint, bigint] | null;
  assertValidBabyJubjubPublicKey(unpacked, 'shareableViewingKey.spub');

  return { viewingPrivateKey, spendingPublicKey: unpacked };
}
