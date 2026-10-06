// ABOUTME: Privacy nudges: pure, local-only checks that flag the habits that undo shielded privacy
// ABOUTME: (self-submitting, matching in/out amounts, quick exits, patterns). Never blocks; caller decides.

import type { HistoryEntry } from '../sync/index';

/** What the user is about to do. Amounts are token base units (USDC: 6dp). */
export type PrivacyActionKind =
  | 'shield'
  | 'unshield'
  | 'transfer'
  | 'cross-chain-shield'
  | 'cross-chain-unshield'
  | 'yield-deposit'
  | 'yield-withdraw'
  | 'share-viewing-key';

export interface PlannedPrivacyAction {
  readonly kind: PrivacyActionKind;
  /** Amount moved, in token base units. Omit for actions with no amount (viewing-key share). */
  readonly amount?: bigint;
  /** Public recipient address of an unshield. */
  readonly recipient?: string;
  /** Who submits the transaction. Defaults to `'relayer'`. */
  readonly submittedBy?: 'relayer' | 'self';
}

export interface PrivacyThresholds {
  /** In/out amounts within this many basis points count as a match. Default 100 (1%): covers the
   *  shield fee taken from the deposit plus a relayer fee taken at exit. */
  readonly amountMatchBps: number;
  /** An unshield this soon (seconds) after the user's latest shield is a quick exit. Default 86400. */
  readonly quickExitSeconds: number;
  /** Fewer pool shields + transfers than this in the last 24h means the pool is quiet. Default 20. */
  readonly quietPoolMin: number;
  /** How far (seconds) to push a "remind me later" for a quiet pool. Default 43200 (12h). */
  readonly quietPoolRemindSeconds: number;
  /** Unshields (this one included) that share a recipient or size before it reads as a pattern. Default 3. */
  readonly patternMinCount: number;
  /** Sizes within this many basis points count as "similar" for pattern detection. Default 500 (5%). */
  readonly patternSizeBps: number;
  /** A yield withdrawal within this many bps of a lend counts as a match. Default 200 (2%, for accrued yield). */
  readonly yieldMatchBps: number;
  /** A matching yield withdrawal this soon (seconds) after the lend is flagged. Default 259200 (3 days). */
  readonly yieldQuickSeconds: number;
  /** Amounts at or above this (base units) are "unusually large" for the pool. Unset: size isn't checked. */
  readonly largeAmount?: bigint;
}

export const DEFAULT_PRIVACY_THRESHOLDS: PrivacyThresholds = {
  amountMatchBps: 100,
  quickExitSeconds: 86_400,
  quietPoolMin: 20,
  quietPoolRemindSeconds: 43_200,
  patternMinCount: 3,
  patternSizeBps: 500,
  yieldMatchBps: 200,
  yieldQuickSeconds: 259_200,
};

export interface PrivacyContext {
  /** The wallet's own history (`await wallet.history()`). Read locally, never sent anywhere. */
  readonly history: readonly HistoryEntry[];
  /** Current time, unix seconds. Injected so checks are deterministic. */
  readonly now: number;
  /** Public addresses this wallet has shielded from. The app knows these (it signed the shields). */
  readonly depositAddresses?: readonly string[];
  /** Public pool activity, from chain events: shields + transfers in the last 24h. Omit to skip. */
  readonly poolActivity?: { readonly recentActions24h: number };
  /** The app's network setup. Omit to skip the network check. */
  readonly network?: { readonly privateRpc?: boolean; readonly tor?: boolean };
  /** Token decimals for amount checks. Default 6 (USDC). */
  readonly decimals?: number;
  readonly thresholds?: Partial<PrivacyThresholds>;
}

export type PrivacyCheckId =
  | 'no-relayer'
  | 'same-address'
  | 'same-amount'
  | 'quick-exit'
  | 'quiet-pool'
  | 'distinctive-amount'
  | 'regular-pattern'
  | 'cross-chain-public'
  | 'yield-match'
  | 'viewing-key-share'
  | 'network';

/** A ready-made alternative the app can offer as a one-click fix. */
export type PrivacyFix =
  | { readonly kind: 'use-relayer' }
  | { readonly kind: 'fresh-address' }
  | { readonly kind: 'split'; readonly parts: readonly bigint[] }
  | { readonly kind: 'delay'; readonly notBefore: number }
  | { readonly kind: 'remind'; readonly at: number }
  | { readonly kind: 'change-amount'; readonly suggested: bigint }
  | { readonly kind: 'pay-in-pool' }
  | { readonly kind: 'type-to-confirm'; readonly phrase: string }
  | { readonly kind: 'network-settings' }
  | { readonly kind: 'learn-more'; readonly topic: 'cross-chain' };

export type PrivacyWarningLevel = 'info' | 'warn' | 'strong';

export interface PrivacyWarning {
  readonly id: PrivacyCheckId;
  readonly level: PrivacyWarningLevel;
  /** Default copy. Apps are free to restyle or reword it. */
  readonly title: string;
  readonly body: string;
  readonly fix?: PrivacyFix;
}

export interface PrivacyReport {
  /** `good`: nothing above info. `fair`: one warn, or an amount-related info. `weak`: any strong, or 2+ warns. */
  readonly level: 'good' | 'fair' | 'weak';
  readonly warnings: readonly PrivacyWarning[];
}

const SPEND_KINDS: ReadonlySet<PrivacyActionKind> = new Set([
  'unshield',
  'transfer',
  'cross-chain-unshield',
  'yield-deposit',
  'yield-withdraw',
]);
const EXIT_KINDS: ReadonlySet<PrivacyActionKind> = new Set(['unshield', 'cross-chain-unshield']);
const AMOUNT_KINDS: ReadonlySet<PrivacyActionKind> = new Set([
  'shield',
  'unshield',
  'cross-chain-shield',
  'cross-chain-unshield',
]);
const AMOUNT_INFO: ReadonlySet<PrivacyCheckId> = new Set(['distinctive-amount', 'yield-match']);

const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/** |a - b| is within `bps` basis points of the larger of the two. */
function withinBps(a: bigint, b: bigint, bps: number): boolean {
  const base = abs(a) > abs(b) ? abs(a) : abs(b);
  if (base === 0n) return true;
  return abs(abs(a) - abs(b)) * 10_000n <= base * BigInt(bps);
}

const sameAddress = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/**
 * Split an amount into 2 or 3 uneven parts, each a whole token unit except the last, so no part
 * repeats the original amount. Deterministic: the same amount always yields the same split.
 */
export function suggestSplit(amount: bigint, decimals = 6): bigint[] {
  const unit = 10n ** BigInt(decimals);
  if (amount < unit * 3n) {
    const first = (amount * 58n) / 100n;
    return [first, amount - first];
  }
  const p1 = ((amount * 53n) / 100n / unit) * unit;
  const p2 = ((amount * 29n) / 100n / unit) * unit;
  return [p1, p2, amount - p1 - p2];
}

const hours = (seconds: number): string => {
  const h = Math.max(1, Math.round(seconds / 3600));
  return `${h} hour${h === 1 ? '' : 's'}`;
};

/** Format base units as a readable amount: 12_480_370_000n (6dp) -> "12,480.37". */
export function formatAmount(amount: bigint, decimals = 6): string {
  const unit = 10n ** BigInt(decimals);
  const whole = (amount / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (amount % unit).toString().padStart(decimals, '0').slice(0, 2).replace(/0+$/, '');
  return frac === '' ? whole : `${whole}.${frac}`;
}

const ordinal = (n: number): string => {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
};

/**
 * Run the privacy nudges over a planned action and the wallet's own history. Pure and local: no
 * network calls, nothing leaves the device. Returns warnings with default copy and a suggested fix.
 * It never blocks: pool access is unconditional, so the caller decides whether to show, fix or proceed.
 */
export function checkPrivacy(action: PlannedPrivacyAction, ctx: PrivacyContext): PrivacyReport {
  const t: PrivacyThresholds = { ...DEFAULT_PRIVACY_THRESHOLDS, ...ctx.thresholds };
  const decimals = ctx.decimals ?? 6;
  const unit = 10n ** BigInt(decimals);
  const warnings: PrivacyWarning[] = [];
  const shields = ctx.history.filter((e) => e.category === 'shield');
  const amount = action.amount;
  const isExit = EXIT_KINDS.has(action.kind);

  // 10. Viewing key share: irreversible, so it always asks for a typed confirmation.
  if (action.kind === 'share-viewing-key') {
    warnings.push({
      id: 'viewing-key-share',
      level: 'strong',
      title: "Sharing a viewing key can't be undone.",
      body: "Whoever has it can see your full history, forever. They can't move your funds.",
      fix: { kind: 'type-to-confirm', phrase: 'confirm' },
    });
    return { level: levelOf(warnings), warnings };
  }

  // 1. No relayer: self-submitting puts the user's funded public address on the transaction.
  if ((action.submittedBy ?? 'relayer') === 'self' && SPEND_KINDS.has(action.kind)) {
    warnings.push({
      id: 'no-relayer',
      level: 'strong',
      title: 'Your wallet address will be on this transaction.',
      body: 'Submitting it yourself links it to your public wallet. A relayer submits it for you and keeps your address off.',
      fix: { kind: 'use-relayer' },
    });
  }

  // 2. Same address out as in.
  if (isExit && action.recipient !== undefined && (ctx.depositAddresses ?? []).some((a) => sameAddress(a, action.recipient))) {
    warnings.push({
      id: 'same-address',
      level: 'strong',
      title: 'This is the address you deposited from.',
      body: 'Anyone can connect your deposit and this withdrawal. Send it to a new address.',
      fix: { kind: 'fresh-address' },
    });
  }

  // 3. Same amount out as in: compare against each shield's gross deposit and net note value.
  if (isExit && amount !== undefined) {
    const matches = shields.some((s) => {
      const net = abs(s.value);
      const gross = net + (s.shieldFee ?? 0n);
      return withinBps(amount, net, t.amountMatchBps) || withinBps(amount, gross, t.amountMatchBps);
    });
    if (matches) {
      warnings.push({
        id: 'same-amount',
        level: 'strong',
        title: 'This is the same amount you deposited.',
        body: 'Same amount in and out is the easiest link to make. Withdraw a different amount, or split it into parts.',
        fix: { kind: 'split', parts: suggestSplit(amount, decimals) },
      });
    }
  }

  // 4. Quick exit: an unshield soon after the user's latest shield.
  if (isExit) {
    const latest = shields.reduce<number | undefined>(
      (max, s) => (s.timestamp !== undefined && (max === undefined || s.timestamp > max) ? s.timestamp : max),
      undefined,
    );
    if (latest !== undefined && ctx.now - latest < t.quickExitSeconds) {
      warnings.push({
        id: 'quick-exit',
        level: 'warn',
        title: `You deposited ${hours(ctx.now - latest)} ago.`,
        body: 'Withdrawing this soon makes it easy to match to your deposit. The longer you wait, the more people move money after you.',
        fix: { kind: 'delay', notBefore: latest + t.quickExitSeconds },
      });
    }
  }

  // 5. Quiet pool: few other people moving money right now.
  if (ctx.poolActivity !== undefined && ctx.poolActivity.recentActions24h < t.quietPoolMin) {
    warnings.push({
      id: 'quiet-pool',
      level: 'warn',
      title: 'The pool is quiet right now.',
      body: `Only ${ctx.poolActivity.recentActions24h} transactions in the last 24 hours, so yours is easier to pick out. Try again later.`,
      fix: { kind: 'remind', at: ctx.now + t.quietPoolRemindSeconds },
    });
  }

  // 6. Distinctive amount: fractional units, or unusually large for the pool.
  if (AMOUNT_KINDS.has(action.kind) && amount !== undefined) {
    const fractional = amount % unit !== 0n;
    const large = t.largeAmount !== undefined && amount >= t.largeAmount;
    if (fractional || large) {
      warnings.push({
        id: 'distinctive-amount',
        level: 'info',
        title: `${formatAmount(amount, decimals)} stands out.`,
        body: large
          ? 'Very few people move this much at once, so it is easy to follow. Splitting it helps.'
          : `Few people move exactly ${formatAmount(amount, decimals)}, so it is easy to follow in and out. A round amount blends in.`,
        fix: large
          ? { kind: 'split', parts: suggestSplit(amount, decimals) }
          : { kind: 'change-amount', suggested: (amount / (unit * 10n)) * unit * 10n },
      });
    }
  }

  // 7. Regular pattern: repeated unshields to the same recipient or of a similar size.
  if (isExit && (amount !== undefined || action.recipient !== undefined)) {
    const similar = ctx.history.filter(
      (e) =>
        e.category === 'unshield' &&
        (sameAddress(e.recipient, action.recipient) ||
          (amount !== undefined && withinBps(abs(e.value), amount, t.patternSizeBps))),
    );
    if (similar.length + 1 >= t.patternMinCount) {
      warnings.push({
        id: 'regular-pattern',
        level: 'warn',
        title: `This is your ${ordinal(similar.length + 1)} withdrawal like this.`,
        body: 'Repeated withdrawals of the same size, or to the same address, can identify you over time. Paying people inside the pool leaves no public trail.',
        fix: { kind: 'pay-in-pool' },
      });
    }
  }

  // 8. Cross-chain is public while in flight (the CCTP message carries the amount in the clear).
  if (action.kind === 'cross-chain-shield' || action.kind === 'cross-chain-unshield') {
    warnings.push({
      id: 'cross-chain-public',
      level: 'info',
      title: 'The amount is public while it moves between chains.',
      body: 'Anyone can see how much is moving until it reaches the pool.',
      fix: { kind: 'learn-more', topic: 'cross-chain' },
    });
  }

  // 9. Yield in/out match: vault deposits and redemptions are public amounts.
  if (action.kind === 'yield-withdraw' && amount !== undefined) {
    const lend = ctx.history.find(
      (e) =>
        e.category === 'yield-deposit' &&
        e.timestamp !== undefined &&
        ctx.now - e.timestamp < t.yieldQuickSeconds &&
        withinBps(abs(e.value), amount, t.yieldMatchBps),
    );
    if (lend !== undefined) {
      warnings.push({
        id: 'yield-match',
        level: 'info',
        title: 'This matches what you put into yield.',
        body: 'Vault deposits and withdrawals are public, so the same amount this soon can be linked. Withdraw a different amount or wait a few days.',
        fix: { kind: 'delay', notBefore: (lend.timestamp ?? ctx.now) + t.yieldQuickSeconds },
      });
    }
  }

  // 11. Network: no private RPC or Tor configured.
  if (ctx.network !== undefined && !ctx.network.privateRpc && !ctx.network.tor) {
    warnings.push({
      id: 'network',
      level: 'info',
      title: 'Your IP address can link you to this transaction.',
      body: 'Connect through Tor or a private RPC to hide it.',
      fix: { kind: 'network-settings' },
    });
  }

  return { level: levelOf(warnings), warnings };
}

function levelOf(warnings: readonly PrivacyWarning[]): PrivacyReport['level'] {
  if (warnings.some((w) => w.level === 'strong')) return 'weak';
  const warns = warnings.filter((w) => w.level === 'warn').length;
  if (warns >= 2) return 'weak';
  if (warns === 1 || warnings.some((w) => AMOUNT_INFO.has(w.id))) return 'fair';
  return 'good';
}
