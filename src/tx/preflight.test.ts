// ABOUTME: Tests for runPreflight (§4.7) — root freshness, nullifier-unspent, fee-quote expiry over a
// ABOUTME: Plan, with injected on-chain queries so the orchestration is exercised without a chain.

import { describe, it, expect } from 'vitest';
import { runPreflight, type PreflightQueries } from './preflight';
import type { Plan } from './index';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;

// A minimal plan spending two inputs from tree 0, proved against root 111.
const plan = (): Plan => ({
  shape: { nullifiers: 2, commitments: 1 },
  merkleRoot: 111n,
  summary: { tokenAddress: USDC, inputTotal: 6n, outputs: [], changeValue: 0n },
  boundParams: {
    treeNumber: 0, minGasPrice: 0n, unshield: 0, chainID: 31337n,
    adaptContract: '0x0000000000000000000000000000000000000000', adaptParams: `0x${'00'.repeat(32)}`,
  },
  selectedInputs: [
    { tree: 0, position: 0, tokenHash: 'ee', value: 3n, blockNumber: 1, txid: '0x', origin: 'transact', random: '00'.repeat(16), notePublicKey: 0n },
    { tree: 0, position: 1, tokenHash: 'ee', value: 3n, blockNumber: 1, txid: '0x', origin: 'transact', random: '00'.repeat(16), notePublicKey: 0n },
  ],
  merkleProofs: [[1n], [2n]],
});

const nullifiers = [{ tree: 0, nullifier: 10n }, { tree: 0, nullifier: 20n }];
const allGood: PreflightQueries = { isKnownRoot: async () => true, isNullifierSpent: async () => false };
const NOW = 1_000_000;

describe('runPreflight (§4.7)', () => {
  it('passes when the root is fresh, no input is spent, and the fee quote is unexpired', async () => {
    const res = await runPreflight({ plan: plan(), nullifiers, queries: allGood, feeQuote: { expiresAt: NOW + 1 }, now: NOW });
    expect(res.ok).toBe(true);
    expect(res.findings.map((f) => f.check)).toEqual(['root-freshness', 'nullifier-unspent', 'nullifier-unspent', 'fee-quote-expiry']);
    expect(res.findings.every((f) => f.ok)).toBe(true);
  });

  it('fails root-freshness when the plan root is no longer in the pool history', async () => {
    const res = await runPreflight({ plan: plan(), nullifiers, queries: { ...allGood, isKnownRoot: async () => false }, now: NOW });
    expect(res.ok).toBe(false);
    expect(res.findings.find((f) => f.check === 'root-freshness')).toMatchObject({ ok: false });
  });

  it('fails nullifier-unspent when an input note is already spent on-chain', async () => {
    // Only the second nullifier (20n) is spent → its finding fails, overall fails.
    const queries: PreflightQueries = { isKnownRoot: async () => true, isNullifierSpent: async (_t, n) => n === 20n };
    const res = await runPreflight({ plan: plan(), nullifiers, queries, now: NOW });
    expect(res.ok).toBe(false);
    const nf = res.findings.filter((f) => f.check === 'nullifier-unspent');
    expect(nf.map((f) => f.ok)).toEqual([true, false]);
  });

  it('flags an expired fee quote, and omits the check entirely when no quote is given', async () => {
    const expired = await runPreflight({ plan: plan(), nullifiers, queries: allGood, feeQuote: { expiresAt: NOW }, now: NOW });
    expect(expired.ok).toBe(false);
    expect(expired.findings.find((f) => f.check === 'fee-quote-expiry')).toMatchObject({ ok: false });

    const noQuote = await runPreflight({ plan: plan(), nullifiers, queries: allGood, now: NOW });
    expect(noQuote.findings.some((f) => f.check === 'fee-quote-expiry')).toBe(false);
    expect(noQuote.ok).toBe(true);
  });
});
