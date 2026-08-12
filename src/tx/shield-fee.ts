// ABOUTME: Shield fee gross-up + npk-reconstruction fee verification (SPEC §4.6.1/#410). The SDK computes
// ABOUTME: what the on-chain fee module enforces, so a gasless-shield fee note nets the relayer's target.

import { ShieldNote } from '../core/index';
import { InvalidRequestError } from '../errors';
import type { ShieldRequest } from './shield';

const BPS_DENOMINATOR = 10000n;

/**
 * The shield fee tiers, in basis points, as the on-chain fee module applies them
 * (`ArmadaFeeModule.calculateShieldFee`): the Armada take (default 50 bps; 40 bps at the ≥$250k tier)
 * and, only for a registered integrator, the integrator total. Each is floored independently and summed.
 * For the flat-fallback path (`feeModule == address(0)`), pass the single rate as `armadaTakeBps`.
 */
export interface ShieldFeeTiers {
  readonly armadaTakeBps: number;
  readonly integratorBps?: number;
}

/** The on-chain shield fee for a gross note value — `floor(G·aBps/1e4) + floor(G·iBps/1e4)`. */
export function shieldFee(gross: bigint, tiers: ShieldFeeTiers): bigint {
  const a = BigInt(tiers.armadaTakeBps);
  const i = BigInt(tiers.integratorBps ?? 0);
  return (gross * a) / BPS_DENOMINATOR + (gross * i) / BPS_DENOMINATOR;
}

/** The net value credited after the shield fee — `gross − shieldFee(gross)`. */
export function shieldNet(gross: bigint, tiers: ShieldFeeTiers): bigint {
  return gross - shieldFee(gross, tiers);
}

/**
 * Gross up a desired NET amount to the smallest gross note value `G` such that `shieldNet(G) >= net`
 * — so a relayer fee note nets its target after the pool deducts the shield fee (SPEC §4.6.1). The
 * per-component floors make this non-closed-form: start from the combined-rate ceil (which always nets
 * ≥ target, since sum-of-floors ≤ floor-of-sum) and tighten down to the true minimum. Retires the
 * tracked shield-fee-formula-mismatch shortcut — the SDK computes what the contract enforces.
 */
export function grossUpShieldFee(net: bigint, tiers: ShieldFeeTiers): bigint {
  if (net <= 0n) throw new InvalidRequestError('grossUpShieldFee: net must be positive');
  const bps = BigInt(tiers.armadaTakeBps) + BigInt(tiers.integratorBps ?? 0);
  if (bps < 0n || bps >= BPS_DENOMINATOR) {
    throw new InvalidRequestError('grossUpShieldFee: total fee bps must be in [0, 10000)');
  }
  if (bps === 0n) return net;
  let g = (net * BPS_DENOMINATOR + (BPS_DENOMINATOR - bps) - 1n) / (BPS_DENOMINATOR - bps); // ceil(net·D/(D−bps))
  while (g > net && shieldNet(g - 1n, tiers) >= net) g -= 1n;
  while (shieldNet(g, tiers) < net) g += 1n; // safety — the ceil start already satisfies this
  return g;
}

/**
 * Reconstruct a shield note's public key from the recipient's master public key and the note's random:
 * `npk = Poseidon(masterPublicKey, random)` (engine `ShieldNote.getNotePublicKey`). `random` is 16-byte hex.
 */
export function reconstructShieldNpk(masterPublicKey: bigint, random: string): bigint {
  return ShieldNote.getNotePublicKey(masterPublicKey, random);
}

/**
 * npk-reconstruction shield-fee verification (SPEC §4.6, #410 relayer primitive). Given the shield
 * requests, the relayer's own master public key, and the per-note `random` it was handed, find the note
 * addressed to the relayer (its reconstructed npk matches a request's `preimage.npk`) and confirm the
 * declared value is at least `minValue` (the advertised fee) — without decrypting anything. Returns the
 * matched note's declared value, or `undefined` if no note is addressed to the relayer or it underpays.
 * (The pool then deducts the shield fee from this declared value; the SDK's `grossUpShieldFee` is what
 * makes the post-fee net still cover the relayer's target.)
 */
export function verifyShieldFeeNote(params: {
  readonly shieldRequests: readonly ShieldRequest[];
  readonly broadcasterMasterPublicKey: bigint;
  readonly random: string;
  readonly minValue: bigint;
}): { readonly value: bigint } | undefined {
  const npk = reconstructShieldNpk(params.broadcasterMasterPublicKey, params.random);
  for (const req of params.shieldRequests) {
    if (BigInt(req.preimage.npk) === npk) {
      return req.preimage.value >= params.minValue ? { value: req.preimage.value } : undefined;
    }
  }
  return undefined;
}
