// ABOUTME: Tests for runPreflight (§4.7) — root freshness, nullifier-unspent, fee-quote expiry over a
// ABOUTME: Plan, with injected on-chain queries so the orchestration is exercised without a chain.

import { describe, it, expect } from 'vitest';
import { AbiCoder } from 'ethers';
import { runPreflight, readShieldsPaused, type PreflightQueries } from './preflight';
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
  it('passes when the root is fresh, no input is spent, the fee quote is unexpired, and balances suffice', async () => {
    const res = await runPreflight({ plan: plan(), nullifiers, queries: allGood, feeQuote: { expiresAt: NOW + 1 }, now: NOW });
    expect(res.ok).toBe(true);
    expect(res.findings.map((f) => f.check)).toEqual([
      'root-freshness', 'nullifier-unspent', 'nullifier-unspent', 'fee-quote-expiry', 'balance-sufficiency',
    ]);
    expect(res.findings.every((f) => f.ok)).toBe(true);
  });

  it('fails balance-sufficiency when the plan inputs do not cover outputs + fee + unshield', async () => {
    const p = plan();
    const underfunded: typeof p = { ...p, summary: { ...p.summary, inputTotal: 1n, outputs: [{ toShieldedAddress: '0zk', value: 5n, tokenAddress: USDC }] } };
    const res = await runPreflight({ plan: underfunded, nullifiers, queries: allGood, now: NOW });
    expect(res.ok).toBe(false);
    expect(res.findings.find((f) => f.check === 'balance-sufficiency')).toMatchObject({ ok: false });
  });

  it('runs cctp-liveness only when provided, failing on a dead messenger', async () => {
    const live = await runPreflight({ plan: plan(), nullifiers, queries: allGood, now: NOW, cctpLiveness: async () => true });
    expect(live.findings.find((f) => f.check === 'cctp-liveness')).toMatchObject({ ok: true });

    const dead = await runPreflight({ plan: plan(), nullifiers, queries: allGood, now: NOW, cctpLiveness: async () => false });
    expect(dead.ok).toBe(false);
    expect(dead.findings.find((f) => f.check === 'cctp-liveness')).toMatchObject({ ok: false });

    // Not provided (transfer/unshield) → no cctp-liveness finding.
    const none = await runPreflight({ plan: plan(), nullifiers, queries: allGood, now: NOW });
    expect(none.findings.some((f) => f.check === 'cctp-liveness')).toBe(false);
  });

  it('runs shield-pause only when provided, failing when shields are paused', async () => {
    const paused = await runPreflight({ plan: plan(), nullifiers, queries: allGood, now: NOW, shieldsPaused: async () => true });
    expect(paused.ok).toBe(false);
    expect(paused.findings.find((f) => f.check === 'shield-pause')).toMatchObject({ ok: false });

    const open = await runPreflight({ plan: plan(), nullifiers, queries: allGood, now: NOW, shieldsPaused: async () => false });
    expect(open.findings.find((f) => f.check === 'shield-pause')).toMatchObject({ ok: true });
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

describe('readShieldsPaused (§4.7 shield-pause reader)', () => {
  const coder = AbiCoder.defaultAbiCoder();
  const CONTROLLER = '0x' + '55'.repeat(20);

  it('encodes shieldsPaused() and decodes the boolean from an injected eth_call', async () => {
    const ethCall = async (tx: { to: string; data: string }): Promise<string> => {
      expect(tx.to).toBe(CONTROLLER);
      expect(tx.data.slice(0, 10)).toBe('0x4d52a10e'); // selector of shieldsPaused()
      return coder.encode(['bool'], [true]);
    };
    expect(await readShieldsPaused(ethCall, CONTROLLER)).toBe(true);
    expect(await readShieldsPaused(async () => coder.encode(['bool'], [false]), CONTROLLER)).toBe(false);
  });
});
