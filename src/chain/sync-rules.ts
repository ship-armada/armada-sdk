// ABOUTME: The chain sync's pure decision rules (SPEC §4.4/§8): quick-sync telemetry and its fallback reasons, when a
// ABOUTME: sync owes a final root check, and when a failure means rescan (a missing-leaves tree, a reorg-poisoned one).

import { RootMismatchError } from '../errors';

/**
 * Why an untrusted-indexer quick-sync attempt was discarded for an RPC re-scan. The `outcome` field
 * keeps its two historical values (back-compat); `reason` disambiguates the ≥4 distinct causes that
 * `root-mismatch-fallback` used to conflate (#83). `unknown` is the honest bucket for an unexpected
 * cause — never silently folded into `root-mismatch`.
 */
export type QuickSyncReason = 'indexer-http-error' | 'schema-mismatch' | 'root-mismatch' | 'position-gap' | 'unknown';

/** Quick-sync observability payload emitted through the telemetry sink (SPEC §8-safe: block numbers + booleans only). */
export interface QuickSyncTelemetry {
  /** `served` = the indexer batch verified against the on-chain root; `root-mismatch-fallback` = it
   *  didn't, so the batch was discarded and the range re-scanned from RPC (truth). */
  readonly outcome: 'served' | 'root-mismatch-fallback';
  readonly fromBlock: number;
  readonly head: number;
  /** On the `served` path: the indexer lagged the chain head and RPC covered the tail. Always false on fallback. */
  readonly tailCovered: boolean;
  /** Set only on fallback: the classified cause of the discard (SPEC §8-safe — an enum, no PII). */
  readonly reason?: QuickSyncReason;
  /** Set only for an `indexer-http-error` fallback: the non-OK HTTP status the indexer returned. */
  readonly status?: number;
}

/**
 * Map a caught quick-sync fallback cause to its telemetry reason (+ HTTP status when applicable). Pure
 * and keyed on the typed-error `code` (never message text), so a 404 from a legacy endpoint is reported
 * as `indexer-http-error`, not a misleading `root-mismatch`. An unrecognized cause is `unknown` — the
 * classifier never asserts a cause it doesn't actually know (SPEC §8, #83).
 */
export function classifyQuickSyncReason(cause: unknown): { reason: QuickSyncReason; status?: number } {
  // Match on the stable `code`, not `instanceof`: identity checks break under the dual-package hazard
  // (an error thrown by one SDK copy fails `instanceof` in another) and contradict the errors.ts rule.
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? (cause as { code: unknown }).code : undefined;
  switch (code) {
    case 'INDEXER_HTTP': {
      const status = (cause as { status?: unknown }).status;
      return typeof status === 'number' ? { reason: 'indexer-http-error', status } : { reason: 'indexer-http-error' };
    }
    case 'QUICK_SYNC_SCHEMA':
      return { reason: 'schema-mismatch' };
    case 'ROOT_MISMATCH':
      return { reason: 'root-mismatch' };
    case 'POSITION_GAP':
      return { reason: 'position-gap' };
    default:
      return { reason: 'unknown' };
  }
}

/**
 * Decide the quick-sync observability event for a completed sync. Pure so the outcome taxonomy is
 * unit-testable without a provider. Returns null when no indexer is in play — a pure RPC sync has
 * nothing quick-sync to report. SPEC §8: the payload carries only block numbers + booleans + a
 * classified `reason` enum, never keys, addresses, or note plaintext.
 */
export function quickSyncTelemetry(input: {
  usingIndexer: boolean;
  tailCovered: boolean;
  fellBack: boolean;
  fromBlock: number;
  head: number;
  /** The caught fallback cause (only meaningful when `fellBack`); classified into `reason`/`status`. */
  cause?: unknown;
}): { event: 'sync.quicksync'; data: QuickSyncTelemetry } | null {
  if (!input.usingIndexer) return null;
  // Only fallbacks carry a cause to classify; the served path emits neither reason nor status.
  const { reason, status } = input.fellBack ? classifyQuickSyncReason(input.cause) : { reason: undefined, status: undefined };
  return {
    event: 'sync.quicksync',
    data: {
      outcome: input.fellBack ? 'root-mismatch-fallback' : 'served',
      fromBlock: input.fromBlock,
      head: input.head,
      // On a fallback the indexer batch was discarded and the whole range RPC-rescanned, so tail-cover
      // is only meaningful on the served path.
      tailCovered: input.fellBack ? false : input.tailCovered,
      ...(reason !== undefined ? { reason } : {}),
      ...(status !== undefined ? { status } : {}),
    },
  };
}

/**
 * Whether a completed sync still owes a final on-chain root verification (SPEC §4.4: "root
 * verification after each batch"). The indexer-served path already verified before acceptance, so
 * only the RPC baseline path and the post-fallback RPC rescan need the closing check — but every
 * sync ends having confirmed its accepted tree against the pool's root. Pure so the invariant
 * "the RPC baseline path is never left unverified" (the H3 regression) is unit-testable.
 */
export function finalRootCheckRequired(usingIndexer: boolean, fellBack: boolean): boolean {
  return !usingIndexer || fellBack;
}

/**
 * Whether a sync should self-heal from a reorg-poisoned PERSISTED tree by resetting + rescanning, rather
 * than rethrowing (SPEC §4.4). True only when the failure is a `RootMismatchError`, the pre-batch (persisted)
 * state ITSELF fails root verification (so the poison predates this batch — a reorg removed an already-scanned
 * leaf), and we are not already inside a recovery (guards an infinite reset loop). Pure for testability.
 */
export function shouldRecoverFromReorg(error: unknown, persistedRootsInvalid: boolean, recovering: boolean): boolean {
  return error instanceof RootMismatchError && persistedRootsInvalid && !recovering;
}

/**
 * Whether a sync failure means the local tree is MISSING leaves: a leaf arrived beyond the tree's next
 * position, so part of the chain was skipped — a checkpoint that advanced past unapplied events, or a tree
 * started after the pool's first commitment. No retry fills that gap; only a rescan can. Keyed on the
 * error's `code` and fields, not identity (dual-package safe). Pure for testability.
 */
export function scanStateMissingLeaves(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; expected?: unknown; received?: unknown };
  return e.code === 'POSITION_GAP' && typeof e.expected === 'number' && typeof e.received === 'number' && e.received > e.expected;
}
