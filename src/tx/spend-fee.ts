// ABOUTME: The broadcaster fee a spend pays (SPEC §4.6.1, #121) — an explicit per-proof amount, plus a strict
// ABOUTME: helper that reads it from a relayer quote for a named operation (no silent tier fallbacks).

import { InvalidRequestError } from '../errors';
import type { FeeQuote } from './index';

/**
 * The broadcaster fee a spend pays: `perProof` (in USDC base units) to the relayer's shielded address, once
 * per proof — a split spend of k proofs pays it k times. Omit it for a spend that pays no in-proof fee (a
 * self-submitted spend, or a yield redeem whose fee the adapter pays contract-side).
 */
export interface SpendFee {
  readonly perProof: bigint;
  readonly broadcasterShieldedAddress: string;
}

/**
 * The relayer's pricing tiers, one per submission path:
 *   - `transfer` / `unshield` — a bare `transact()` (the relayer accepts the lower of the two),
 *   - `crossChainUnshield` — `atomicCrossChainUnshield` (a CCTP-bound unshield),
 *   - `crossContract` — `lendAndShield` / `redeemAndShield` (yield).
 */
export type FeeOperation = 'transfer' | 'unshield' | 'crossChainUnshield' | 'crossContract';

const BASE_UNITS = /^\d+$/;

/**
 * Read the fee for `operation` from a relayer quote (`GET /fees`). Throws `InvalidRequestError` when the
 * quote has no tier for it or the tier isn't a non-negative integer string — never falls back to another
 * tier or to zero, which would bind a fee the relayer rejects only after the user has proved.
 */
export function feeForOperation(
  quote: Pick<FeeQuote, 'schedule' | 'broadcasterShieldedAddress'>,
  operation: FeeOperation,
): SpendFee {
  const raw = quote.schedule[operation];
  if (raw === undefined) throw new InvalidRequestError(`feeForOperation: the fee quote has no '${operation}' tier`);
  if (!BASE_UNITS.test(raw)) {
    throw new InvalidRequestError(`feeForOperation: the '${operation}' tier is not a non-negative integer: ${JSON.stringify(raw)}`);
  }
  return { perProof: BigInt(raw), broadcasterShieldedAddress: quote.broadcasterShieldedAddress };
}
