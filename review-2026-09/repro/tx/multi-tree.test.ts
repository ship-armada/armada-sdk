// ABOUTME: Repro — planSpend commits to the fewest-input tree; when that tree's shape is unregistered it
// ABOUTME: never tries another tree that covers the spend on a registered shape (an unshield fails; a larger one succeeds).
import { describe, it, expect } from 'vitest';
import { walletWith, USDC } from './helpers';
import { UnsupportedCircuitShapeError } from '../../../src/errors';

const FEE = { schedule: { transfer: '1', unshield: '1' }, broadcasterShieldedAddress: '0zk_b', feesCacheId: 'c', expiresAt: Date.now() + 60_000 };
const recipient = `0x${'ab'.repeat(20)}` as const;

describe('planner does not fall back across trees', () => {
  it('unshield: tree 0 needs 5 notes + change (5x3 unregistered) while tree 1 covers exactly with 6 notes (6x2)', async () => {
    const notes = [
      ...Array.from({ length: 5 }, () => ({ tree: 0, token: USDC, value: 13n })), // 65
      ...Array.from({ length: 6 }, () => ({ tree: 1, token: USDC, value: 10n })), // 60
    ];
    const { sdk, wallet } = await walletWith(notes, { sweepNoteThreshold: 0 });
    // 59 + 1 fee = 60: tree 1 plans it as 6x2 (registered).
    await expect(wallet.planTransfer({ outputs: [], unshield: { recipient, amount: 59n }, fee: FEE })).rejects.toThrow(UnsupportedCircuitShapeError);
    // Yet a LARGER unshield plans (tree 0 exact, 5x2) — non-monotonic.
    await expect(wallet.planTransfer({ outputs: [], unshield: { recipient, amount: 64n }, fee: FEE })).resolves.toHaveLength(1);
    await sdk.close();
  });

});
