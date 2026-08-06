// ABOUTME: Shareable viewing-key codec (SPEC §4.2.2) — byte-compatible with Railgun's
// ABOUTME: generateShareableViewingKey: hex(msgpack({ vpriv, spub: packPoint(spendingPublicKey) })).

import msgpack from 'msgpack-lite';
import { Babyjubjub } from '../core/index';

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
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Encode a shareable viewing key — the exact Railgun wire format (interoperable with stock wallets). */
export function encodeShareableViewingKey(material: ShareableViewingKeyMaterial): string {
  const spub = Buffer.from(Babyjubjub.packPoint(material.spendingPublicKey)).toString('hex');
  const encoded = msgpack.encode({ vpriv: toHex32(material.viewingPrivateKey), spub }) as Buffer;
  return encoded.toString('hex');
}

/** Decode a shareable viewing key (Railgun wire format) back to its viewing key + spending public key. */
export function decodeShareableViewingKey(shareableViewingKey: string): ShareableViewingKeyMaterial {
  const { vpriv, spub } = msgpack.decode(Buffer.from(shareableViewingKey, 'hex')) as { vpriv: string; spub: string };
  return {
    viewingPrivateKey: hexToBytes(vpriv),
    spendingPublicKey: Babyjubjub.unpackPoint(Buffer.from(spub, 'hex')),
  };
}
