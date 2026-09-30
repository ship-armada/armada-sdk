// ABOUTME: Preflight (SPEC §4.7) — cheap pre-proof RPC/local checks over a Plan so the 30-second
// ABOUTME: proof-then-revert failure mode becomes a typed pre-proof finding. Caller decides policy.

import { Interface } from 'ethers';
import type { DecodedBoundParams, Plan } from './index';
import { planList } from './plan';
import {
  FeeQuoteExpiredError,
  InsufficientBalanceError,
  InvalidRequestError,
  NoteAlreadySpentError,
  RootMismatchError,
} from '../errors';

const shieldPauseIface = new Interface(['function shieldsPaused() view returns (bool)']);

/**
 * Read `ShieldPauseController.shieldsPaused()` (SPEC §4.7 shield-pause). Takes an injected `ethCall`
 * (`(tx) => provider.call(tx)`) so it's testable without a chain. A shield builder wires the result as
 * `runPreflight({ shieldsPaused })` — shields are paused ⇒ the `shield-pause` finding fails. This is a
 * SHIELD-path check; the wallet's transfer/unshield preflight does not run it.
 */
export async function readShieldsPaused(
  ethCall: (tx: { to: string; data: string }) => Promise<string>,
  shieldPauseController: string,
): Promise<boolean> {
  const data = shieldPauseIface.encodeFunctionData('shieldsPaused', []);
  const res = await ethCall({ to: shieldPauseController, data });
  return shieldPauseIface.decodeFunctionResult('shieldsPaused', res)[0] as boolean;
}

/** The checks preflight can run over a transfer/unshield plan. */
export type PreflightCheck =
  | 'root-freshness'
  | 'nullifier-unspent'
  | 'fee-quote-expiry'
  | 'balance-sufficiency'
  | 'cctp-liveness'
  | 'shield-pause';

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
  /** The plan — or every group of a split spend, checked together as the one transaction they submit as. */
  readonly plan: Plan | readonly Plan[];
  /** The plans' input-note nullifiers `(tree, nullifier)` — the wallet derives these from its key. */
  readonly nullifiers: readonly { readonly tree: number; readonly nullifier: bigint }[];
  readonly queries: PreflightQueries;
  /**
   * When present, checks the quote the plan binds is still usable: a deadline in epoch ms on the LOCAL
   * clock (e.g. when you fetched the quote + its TTL). Not the relayer's `expiresAt`, which is server
   * wall-clock — comparing it to the local clock turns clock skew into false expiries.
   */
  readonly quoteDeadline?: number;
  /** Current time (ms) — injected for deterministic testing of the expiry check. */
  readonly now: number;
  /**
   * Cross-chain-unshield liveness: resolves true if the CCTP messenger is a live contract. Provided by
   * the wallet only when the plan is a cross-chain unshield (a CCTP `adaptParams` binding); adds a
   * `cctp-liveness` finding so a plan targeting a dead/misconfigured messenger fails preflight, not later.
   */
  readonly cctpLiveness?: () => Promise<boolean>;
  /**
   * Shield-pause: resolves true if shields are currently paused (`ShieldPauseController.shieldsPaused`).
   * Only relevant for the SHIELD path (not transfer/unshield plans), so the wallet's transfer preflight
   * does not provide it; a shield builder can, adding a `shield-pause` finding (ok = NOT paused).
   */
  readonly shieldsPaused?: () => Promise<boolean>;
}

/**
 * Run the preflight checks and return a finding per check. Pure orchestration over injected reads:
 * root freshness (the plan's proved root must still be accepted by the pool), input nullifiers not yet
 * spent on-chain, and fee-quote freshness. All on-chain reads run concurrently. Callers inspect
 * `findings`/`ok` and decide policy; nothing here proves or submits.
 */
export async function runPreflight(params: PreflightParams): Promise<PreflightResult> {
  const plans = planList(params.plan);
  // Split groups usually share one proved root; check each distinct (tree, root) once.
  const roots = new Map<string, { tree: number; root: bigint }>();
  for (const p of plans) roots.set(`${p.boundParams.treeNumber}:${p.merkleRoot}`, { tree: p.boundParams.treeNumber, root: p.merkleRoot });

  const [rootChecks, nullifierChecks] = await Promise.all([
    Promise.all([...roots.values()].map(async (r) => ({ ...r, known: await params.queries.isKnownRoot(r.tree, r.root) }))),
    Promise.all(
      params.nullifiers.map(async (n) => ({ n, spent: await params.queries.isNullifierSpent(n.tree, n.nullifier) })),
    ),
  ]);

  const findings: PreflightFinding[] = [];

  for (const { tree, known } of rootChecks) {
    findings.push(
      known
        ? { check: 'root-freshness', ok: true }
        : {
            check: 'root-freshness',
            ok: false,
            detail: `plan root is no longer in the pool's accepted history for tree ${tree}`,
          },
    );
  }

  for (const { n, spent } of nullifierChecks) {
    findings.push(
      spent
        ? { check: 'nullifier-unspent', ok: false, detail: `an input note is already spent on-chain (tree ${n.tree})` }
        : { check: 'nullifier-unspent', ok: true },
    );
  }

  if (params.quoteDeadline !== undefined) {
    const expired = params.quoteDeadline <= params.now;
    findings.push(
      expired
        ? { check: 'fee-quote-expiry', ok: false, detail: `fee quote deadline ${params.quoteDeadline} has passed` }
        : { check: 'fee-quote-expiry', ok: true },
    );
  }

  // Balance sufficiency (local): the selected inputs must cover every output + fee + unshield. planTransfer
  // guarantees this, so this is a defensive re-check that the plan handed to preflight is self-consistent.
  for (const p of plans) {
    const s = p.summary;
    const spent = s.outputs.reduce((sum, o) => sum + o.value, 0n) + (s.feeOutput?.value ?? 0n) + (s.unshield?.value ?? 0n);
    findings.push(
      s.inputTotal >= spent
        ? { check: 'balance-sufficiency', ok: true }
        : { check: 'balance-sufficiency', ok: false, detail: `plan inputs ${s.inputTotal} do not cover ${spent} (outputs + fee + unshield)` },
    );
  }

  if (params.cctpLiveness !== undefined) {
    const live = await params.cctpLiveness();
    findings.push(
      live
        ? { check: 'cctp-liveness', ok: true }
        : { check: 'cctp-liveness', ok: false, detail: 'cross-chain unshield: CCTP messenger is not a live contract' },
    );
  }

  if (params.shieldsPaused !== undefined) {
    const paused = await params.shieldsPaused();
    findings.push(
      paused
        ? { check: 'shield-pause', ok: false, detail: 'shields are currently paused' }
        : { check: 'shield-pause', ok: true },
    );
  }

  return { ok: findings.every((f) => f.ok), findings };
}

/**
 * Throw the typed error for the first failed finding (no-op when `result.ok`): `root-freshness` →
 * `RootMismatchError`, `nullifier-unspent` → `NoteAlreadySpentError` (SPEC §6.5: e.g. a claim that lost
 * the race), `fee-quote-expiry` → `FeeQuoteExpiredError`, `balance-sufficiency` →
 * `InsufficientBalanceError`, and `cctp-liveness` / `shield-pause` → `InvalidRequestError`. For callers
 * whose policy is "any failed check stops the spend".
 */
export function assertPreflight(result: PreflightResult): void {
  if (result.ok) return;
  const failed = result.findings.find((f) => !f.ok);
  if (failed === undefined) return;
  const detail = failed.detail ?? `preflight check '${failed.check}' failed`;
  switch (failed.check) {
    case 'root-freshness':
      throw new RootMismatchError(detail);
    case 'nullifier-unspent':
      throw new NoteAlreadySpentError(detail);
    case 'fee-quote-expiry':
      throw new FeeQuoteExpiredError(detail);
    case 'balance-sufficiency':
      throw new InsufficientBalanceError(detail);
    case 'cctp-liveness':
    case 'shield-pause':
      throw new InvalidRequestError(detail);
  }
}

const ZERO_ADAPT_PARAMS = BigInt(0);

/**
 * Whether a plan is a cross-chain (CCTP) unshield, from what its proof commits: an adapt binding
 * (`adaptParams` non-zero) to anything but the yield adapter. The single classification preflight uses —
 * it doesn't depend on the caller having passed the decoded binding. With `yieldAdapterAddress` unset, a
 * yield call counts as cross-chain (configure `pool.wrappers.yieldAdapter` to tell them apart).
 */
export function isCrossChainUnshield(
  boundParams: Pick<DecodedBoundParams, 'adaptContract' | 'adaptParams'>,
  yieldAdapterAddress: string | undefined,
): boolean {
  if (BigInt(boundParams.adaptParams) === ZERO_ADAPT_PARAMS) return false;
  return yieldAdapterAddress === undefined || boundParams.adaptContract.toLowerCase() !== yieldAdapterAddress.toLowerCase();
}
