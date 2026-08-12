// ABOUTME: Preflight (SPEC §4.7) — cheap pre-proof RPC/local checks over a Plan so the 30-second
// ABOUTME: proof-then-revert failure mode becomes a typed pre-proof finding. Caller decides policy.

import type { Plan } from './index';

/** The checks preflight can run over a transfer/unshield plan. */
export type PreflightCheck = 'root-freshness' | 'nullifier-unspent' | 'fee-quote-expiry';

export interface PreflightFinding {
  readonly check: PreflightCheck;
  readonly ok: boolean;
  /** Human-readable reason when `ok` is false (never key material / amounts-with-identity). */
  readonly detail?: string;
}

export interface PreflightResult {
  /** True iff every finding passed. Callers decide whether to proceed — the SDK never auto-proceeds. */
  readonly ok: boolean;
  readonly findings: readonly PreflightFinding[];
}

/** On-chain reads preflight needs — injected so the orchestration is unit-testable without a chain. */
export interface PreflightQueries {
  /** Is `root` still in the pool's accepted root history for `treeNumber` (freshness)? */
  isKnownRoot(treeNumber: number, root: bigint): Promise<boolean>;
  /** Has this `(treeNumber, nullifier)` already been spent on-chain? */
  isNullifierSpent(treeNumber: number, nullifier: bigint): Promise<boolean>;
}

export interface PreflightParams {
  readonly plan: Plan;
  /** The plan's input-note nullifiers `(tree, nullifier)` — the wallet derives these from its key. */
  readonly nullifiers: readonly { readonly tree: number; readonly nullifier: bigint }[];
  readonly queries: PreflightQueries;
  /** When present, checks the fee quote hasn't expired (a local, no-RPC check). */
  readonly feeQuote?: { readonly expiresAt: number };
  /** Current time (ms) — injected for deterministic testing of the expiry check. */
  readonly now: number;
}

/**
 * Run the preflight checks and return a finding per check. Pure orchestration over injected reads:
 * root freshness (the plan's proved root must still be accepted by the pool), input nullifiers not yet
 * spent on-chain, and fee-quote freshness. All on-chain reads run concurrently. Callers inspect
 * `findings`/`ok` and decide policy; nothing here proves or submits.
 */
export async function runPreflight(params: PreflightParams): Promise<PreflightResult> {
  const [rootKnown, nullifierChecks] = await Promise.all([
    params.queries.isKnownRoot(params.plan.boundParams.treeNumber, params.plan.merkleRoot),
    Promise.all(
      params.nullifiers.map(async (n) => ({ n, spent: await params.queries.isNullifierSpent(n.tree, n.nullifier) })),
    ),
  ]);

  const findings: PreflightFinding[] = [];

  findings.push(
    rootKnown
      ? { check: 'root-freshness', ok: true }
      : {
          check: 'root-freshness',
          ok: false,
          detail: `plan root is no longer in the pool's accepted history for tree ${params.plan.boundParams.treeNumber}`,
        },
  );

  for (const { n, spent } of nullifierChecks) {
    findings.push(
      spent
        ? { check: 'nullifier-unspent', ok: false, detail: `an input note is already spent on-chain (tree ${n.tree})` }
        : { check: 'nullifier-unspent', ok: true },
    );
  }

  if (params.feeQuote !== undefined) {
    const expired = params.feeQuote.expiresAt <= params.now;
    findings.push(
      expired
        ? { check: 'fee-quote-expiry', ok: false, detail: `fee quote expired at ${params.feeQuote.expiresAt}` }
        : { check: 'fee-quote-expiry', ok: true },
    );
  }

  return { ok: findings.every((f) => f.ok), findings };
}
