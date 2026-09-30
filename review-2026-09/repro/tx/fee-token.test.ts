// ABOUTME: Repro — a spend of a non-USDC token (yield redeem of vault shares, or a shares transfer) puts
// ABOUTME: the broadcaster fee note in THAT token, though the relayer only counts USDC (and redeem pays contract-side).
import { describe, it, expect } from 'vitest';
import { walletWith, SHARES, ADAPTER, USDC } from './helpers';

const FEE = {
  schedule: { transfer: '100', unshield: '100', crossContract: '250', crossChainUnshield: '300' },
  broadcasterShieldedAddress: '0zk_broadcaster', feesCacheId: 'c', expiresAt: Date.now() + 60_000,
};

describe('fee note token on non-USDC spends', () => {
  it('yield redeem (unshield shares to the yield adapter) carries an in-proof fee note in SHARES', async () => {
    const { sdk, wallet } = await walletWith(
      [{ tree: 0, token: SHARES, value: 10_000n }, { tree: 0, token: USDC, value: 10_000n }],
      { wrappers: { yieldAdapter: ADAPTER } },
    );
    const plans = await wallet.planTransfer({
      outputs: [],
      tokenAddress: SHARES,
      unshield: { recipient: ADAPTER, amount: 5_000n, adaptContract: ADAPTER, adaptParams: `0x${'cd'.repeat(32)}` },
      fee: FEE,
    });
    expect(plans).toHaveLength(1);
    const fee = plans[0]!.summary.feeOutput!;
    // BUG: 250 raw units of vault SHARES paid to the broadcaster inside the proof — on top of the
    // contract-side USDC `_feeAmount` redeemAndShield pays (relayer redeem-fee-verifier ignores in-proof notes).
    expect(fee.tokenAddress).toBe(SHARES);
    expect(fee.value).toBe(250n);
    await sdk.close();
  });

  it('a private transfer of SHARES pays its fee in SHARES (relayer counts only USDC → FEE_INSUFFICIENT after proving)', async () => {
    const { sdk, wallet } = await walletWith(
      [{ tree: 0, token: SHARES, value: 10_000n }, { tree: 0, token: USDC, value: 10_000n }],
    );
    const plans = await wallet.planTransfer({ outputs: [{ to0zk: '0zk_r', amount: 1_000n }], tokenAddress: SHARES, fee: FEE });
    expect(plans[0]!.summary.feeOutput!.tokenAddress).toBe(SHARES);
    // Contrast: consolidate() of SHARES correctly adds a USDC fee group.
    await sdk.close();
  });
});
