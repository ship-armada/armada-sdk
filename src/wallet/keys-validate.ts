// ABOUTME: Key-material validation (SPEC §4.2) — strict hex parsing + Baby Jubjub point checks
// ABOUTME: (on-curve, prime-order subgroup, non-identity, non-zero). Reject, never silently clamp.

import { babyjub } from '@railgun-community/circomlibjs';
import { InvalidKeyMaterialError } from '../errors';

// The Baby Jubjub neutral element (identity): 0*G = (0, 1). Not a valid public key.
const IDENTITY: readonly [bigint, bigint] = [0n, 1n];

/**
 * Parse a hex string into exactly `expectedLength` bytes, rejecting any non-hex character. The old
 * `parseInt`-per-byte path turned `"zz"` into `NaN → 0`, silently corrupting a bit-flipped key into a
 * different-but-valid-looking one; here a malformed byte throws instead.
 */
export function parseHexBytes(hex: string, expectedLength: number, label: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length !== expectedLength * 2 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new InvalidKeyMaterialError(
      `${label}: expected ${expectedLength} bytes of hex, got ${clean.length / 2} bytes / non-hex input`,
    );
  }
  const out = new Uint8Array(expectedLength);
  for (let i = 0; i < expectedLength; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Validate a viewing private key: exactly 32 bytes and not the zero scalar. (Curve25519 clamps the
 * scalar internally, so canonical-encoding is not a concern here; a zero key, though, is a degenerate
 * identity that must be rejected rather than used.)
 */
export function assertValidViewingPrivateKey(bytes: Uint8Array, label = 'viewingPrivateKey'): void {
  if (bytes.length !== 32) {
    throw new InvalidKeyMaterialError(`${label}: expected 32 bytes, got ${bytes.length}`);
  }
  if (bytes.every((b) => b === 0)) {
    throw new InvalidKeyMaterialError(`${label}: zero scalar`);
  }
}

/**
 * Validate a Baby Jubjub public key, narrowing a possibly-null unpack result to a point. Rejects a
 * malformed/off-curve unpack (`null`), the identity `(0,1)`, the zero point, points not on the curve,
 * and — critically — points outside the prime-order subgroup (a small-subgroup point would otherwise
 * yield a silently wrong master public key / 0zk address). This mirrors the checks a spend proof's
 * public-key witness implicitly relies on.
 */
export function assertValidBabyJubjubPublicKey(
  point: readonly [bigint, bigint] | null | undefined,
  label = 'spendingPublicKey',
): asserts point is [bigint, bigint] {
  if (point === null || point === undefined) {
    throw new InvalidKeyMaterialError(`${label}: not a valid packed point (off-curve or malformed encoding)`);
  }
  const [x, y] = point;
  if (typeof x !== 'bigint' || typeof y !== 'bigint') {
    throw new InvalidKeyMaterialError(`${label}: malformed point (non-bigint coordinates)`);
  }
  if (x === IDENTITY[0] && y === IDENTITY[1]) {
    throw new InvalidKeyMaterialError(`${label}: identity point (0,1)`);
  }
  if (x === 0n && y === 0n) {
    throw new InvalidKeyMaterialError(`${label}: zero point`);
  }
  if (!babyjub.inCurve(point as [bigint, bigint])) {
    throw new InvalidKeyMaterialError(`${label}: point not on the Baby Jubjub curve`);
  }
  if (!babyjub.inSubgroup(point as [bigint, bigint])) {
    throw new InvalidKeyMaterialError(`${label}: point not in the prime-order subgroup`);
  }
}
