// ABOUTME: Tests for the privacy nudges: each check fires on its trigger, stays quiet otherwise, and
// ABOUTME: the report level follows the good / fair / weak rules.

import { describe, it, expect } from 'vitest';
import { checkPrivacy, suggestSplit, formatAmount } from './check';
import type { HistoryEntry } from '../sync/index';

const USDC = 1_000_000n;
const NOW = 1_790_000_000;
const HOUR = 3600;
const DAY = 86_400;
const DEPOSIT_ADDR = '0x1111111111111111111111111111111111111111';
const FRESH_ADDR = '0x2222222222222222222222222222222222222222';

const entry = (over: Partial<HistoryEntry> & Pick<HistoryEntry, 'category' | 'value'>): HistoryEntry => ({
  txid: `0x${Math.abs(Number(over.value % 1_000_000_000n)).toString(16)}${over.category}`,
  blockNumber: 1,
  tokenHash: '00',
  tokenAddress: '0x0000000000000000000000000000000000000001',
  ...over,
});

const shieldEntry = (value: bigint, timestamp: number, shieldFee = (value * 5n) / 995n): HistoryEntry =>
  entry({ category: 'shield', value, shieldFee, timestamp });

const ids = (r: ReturnType<typeof checkPrivacy>): string[] => r.warnings.map((w) => w.id);

describe('checkPrivacy', () => {
  it('a careful relayed unshield to a fresh address is good', () => {
    const r = checkPrivacy(
      { kind: 'unshield', amount: 3_000n * USDC, recipient: FRESH_ADDR },
      { history: [shieldEntry(9_950n * USDC, NOW - 10 * DAY)], now: NOW, depositAddresses: [DEPOSIT_ADDR] },
    );
    expect(r.warnings).toEqual([]);
    expect(r.level).toBe('good');
  });

  it('flags self-submitted spends but not shields', () => {
    expect(ids(checkPrivacy({ kind: 'transfer', amount: USDC, submittedBy: 'self' }, { history: [], now: NOW }))).toContain('no-relayer');
    expect(ids(checkPrivacy({ kind: 'shield', amount: USDC, submittedBy: 'self' }, { history: [], now: NOW }))).not.toContain('no-relayer');
  });

  it('flags an unshield back to a deposit address, case-insensitively', () => {
    const r = checkPrivacy(
      { kind: 'unshield', amount: 500n * USDC, recipient: DEPOSIT_ADDR.toUpperCase().replace('0X', '0x') },
      { history: [], now: NOW, depositAddresses: [DEPOSIT_ADDR] },
    );
    expect(ids(r)).toContain('same-address');
    expect(r.warnings.find((w) => w.id === 'same-address')?.fix).toEqual({ kind: 'fresh-address' });
    expect(r.level).toBe('weak');
  });

  it('matches an exit against the gross deposit (note value + shield fee)', () => {
    // Deposited 12,480 gross: note is 12,417.60 after the 0.5% fee. Exiting the full 12,480 matches.
    const net = 12_417_600_000n;
    const r = checkPrivacy(
      { kind: 'unshield', amount: 12_480n * USDC, recipient: FRESH_ADDR },
      { history: [shieldEntry(net, NOW - 10 * DAY, 12_480n * USDC - net)], now: NOW },
    );
    const w = r.warnings.find((x) => x.id === 'same-amount');
    expect(w?.level).toBe('strong');
    expect(w?.fix?.kind).toBe('split');
  });

  it('matches an exit of the net note minus a relayer fee', () => {
    const net = 12_417_600_000n;
    const r = checkPrivacy(
      { kind: 'unshield', amount: net - 25_000n, recipient: FRESH_ADDR },
      { history: [shieldEntry(net, NOW - 10 * DAY)], now: NOW },
    );
    expect(ids(r)).toContain('same-amount');
  });

  it('does not flag a clearly different exit amount', () => {
    const r = checkPrivacy(
      { kind: 'unshield', amount: 7_000n * USDC, recipient: FRESH_ADDR },
      { history: [shieldEntry(12_000n * USDC, NOW - 10 * DAY)], now: NOW },
    );
    expect(ids(r)).not.toContain('same-amount');
  });

  it('flags a quick exit with the hours in the title and a delay fix', () => {
    const r = checkPrivacy(
      { kind: 'unshield', amount: 100n * USDC, recipient: FRESH_ADDR },
      { history: [shieldEntry(5_000n * USDC, NOW - 3 * HOUR)], now: NOW },
    );
    const w = r.warnings.find((x) => x.id === 'quick-exit');
    expect(w?.title).toBe('You deposited 3 hours ago.');
    expect(w?.fix).toEqual({ kind: 'delay', notBefore: NOW - 3 * HOUR + DAY });
    expect(r.level).toBe('fair');
  });

  it('flags a quiet pool with a 12h reminder', () => {
    const r = checkPrivacy({ kind: 'shield', amount: 100n * USDC }, { history: [], now: NOW, poolActivity: { recentActions24h: 4 } });
    const w = r.warnings.find((x) => x.id === 'quiet-pool');
    expect(w?.body).toContain('Only 4 transactions');
    expect(w?.fix).toEqual({ kind: 'remind', at: NOW + 12 * HOUR });
  });

  it('flags fractional amounts and suggests a rounder one', () => {
    const r = checkPrivacy({ kind: 'shield', amount: 12_480_370_000n }, { history: [], now: NOW });
    const w = r.warnings.find((x) => x.id === 'distinctive-amount');
    expect(w?.level).toBe('info');
    expect(w?.title).toBe('12,480.37 stands out.');
    expect(w?.fix).toEqual({ kind: 'change-amount', suggested: 12_480n * USDC });
    expect(r.level).toBe('fair');
  });

  it('flags large amounts only when a threshold is set', () => {
    const big = { kind: 'shield', amount: 500_000n * USDC } as const;
    expect(ids(checkPrivacy(big, { history: [], now: NOW }))).not.toContain('distinctive-amount');
    expect(ids(checkPrivacy(big, { history: [], now: NOW, thresholds: { largeAmount: 100_000n * USDC } }))).toContain('distinctive-amount');
  });

  it('flags a payroll-style pattern after two similar past unshields', () => {
    const past = [
      entry({ category: 'unshield', value: -4_200n * USDC, recipient: '0xaaa', timestamp: NOW - 60 * DAY }),
      entry({ category: 'unshield', value: -4_210n * USDC, recipient: '0xbbb', timestamp: NOW - 30 * DAY }),
    ];
    const r = checkPrivacy({ kind: 'unshield', amount: 4_200n * USDC, recipient: FRESH_ADDR }, { history: past, now: NOW });
    const w = r.warnings.find((x) => x.id === 'regular-pattern');
    expect(w?.title).toBe('This is your 3rd withdrawal like this.');
    expect(w?.fix).toEqual({ kind: 'pay-in-pool' });
  });

  it('notes that cross-chain amounts are public', () => {
    const r = checkPrivacy({ kind: 'cross-chain-unshield', amount: 300n * USDC, recipient: FRESH_ADDR }, { history: [], now: NOW });
    expect(ids(r)).toEqual(['cross-chain-public']);
    expect(r.level).toBe('good');
  });

  it('flags a yield withdrawal matching a recent lend', () => {
    const lend = entry({ category: 'yield-deposit', value: -10_000n * USDC, timestamp: NOW - DAY });
    const r = checkPrivacy({ kind: 'yield-withdraw', amount: 10_010n * USDC }, { history: [lend], now: NOW });
    expect(r.warnings.find((w) => w.id === 'yield-match')?.fix).toEqual({ kind: 'delay', notBefore: NOW - DAY + 3 * DAY });
  });

  it('always asks for a typed confirm before sharing a viewing key', () => {
    const r = checkPrivacy({ kind: 'share-viewing-key' }, { history: [], now: NOW });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.fix).toEqual({ kind: 'type-to-confirm', phrase: 'confirm' });
    expect(r.level).toBe('weak');
  });

  it('suggests a private network only when the app reports none', () => {
    expect(ids(checkPrivacy({ kind: 'transfer', amount: USDC }, { history: [], now: NOW }))).not.toContain('network');
    expect(ids(checkPrivacy({ kind: 'transfer', amount: USDC }, { history: [], now: NOW, network: { tor: true } }))).not.toContain('network');
    expect(ids(checkPrivacy({ kind: 'transfer', amount: USDC }, { history: [], now: NOW, network: {} }))).toContain('network');
  });

  it('two warn checks make a weak report', () => {
    const r = checkPrivacy(
      { kind: 'unshield', amount: 100n * USDC, recipient: FRESH_ADDR },
      { history: [shieldEntry(5_000n * USDC, NOW - HOUR)], now: NOW, poolActivity: { recentActions24h: 1 } },
    );
    expect(ids(r).sort()).toEqual(['quick-exit', 'quiet-pool']);
    expect(r.level).toBe('weak');
  });
});

describe('suggestSplit', () => {
  it('splits into uneven parts that sum to the amount, none equal to it', () => {
    const amount = 12_480n * USDC;
    const parts = suggestSplit(amount);
    expect(parts).toHaveLength(3);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(amount);
    expect(new Set(parts.map(String)).size).toBe(3);
    expect(parts.every((p) => p > 0n && p < amount)).toBe(true);
  });

  it('falls back to two parts for tiny amounts', () => {
    const parts = suggestSplit(2n * USDC);
    expect(parts).toHaveLength(2);
    expect(parts[0]! + parts[1]!).toBe(2n * USDC);
  });
});

describe('formatAmount', () => {
  it('formats base units with separators and up to 2 decimals', () => {
    expect(formatAmount(12_480_370_000n)).toBe('12,480.37');
    expect(formatAmount(1_240_000n * USDC)).toBe('1,240,000');
    expect(formatAmount(500_000n)).toBe('0.5');
  });
});
