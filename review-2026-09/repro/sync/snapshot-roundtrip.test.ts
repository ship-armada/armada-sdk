// ABOUTME: Repro — WalletScanState.snapshot()/restore() drops TXO memo, senderShieldedAddress and shieldFee,
// ABOUTME: so history() after a reload loses memos, disclosed senders, shield fees and selfMetadata.
import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise } from '../../../src/core/index';
import { WalletScanState, reconstructHistory, encodeSelfMetadata } from '../../../src/sync/index';
import type { DecodedTransactCommitment, DecodedShieldCommitment } from '../../../src/sync/index';

const USDC_HASH = '000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const NK = 12345n;

describe('snapshot round-trip', () => {
  beforeAll(async () => { await initPoseidonPromise; });
  it('restored state yields different history than live state', async () => {
    const state = new WalletScanState();
    const t = (pos: number, txid: string): DecodedTransactCommitment => ({
      tree: 0, position: pos, blockNumber: 10 + pos, txid, hash: (100 + pos).toString(16).padStart(64, '0'),
      ciphertext: { ciphertext: [], blindedSenderViewingKey: new Uint8Array(), blindedReceiverViewingKey: new Uint8Array(), memo: '', annotationData: '' },
    });
    const s: DecodedShieldCommitment = {
      tree: 0, position: 0, blockNumber: 5, txid: '0xsh', hash: '01'.padStart(64, '0'), npk: '02', value: 1000n, fee: 3n,
      tokenData: { tokenType: 0, tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', tokenSubID: '0' },
      encryptedBundle: ['', '', ''], shieldKey: '',
    };
    const selfMeta = encodeSelfMetadata('order-42');
    await state.apply(
      { shields: [s], transacts: [t(1, '0xrecv')], nullifiers: [], unshields: [] },
      {
        shield: async () => ({ tokenHash: USDC_HASH, value: 1000n, random: 'aa'.repeat(16), notePublicKey: 7n }),
        transact: async (c) => ({ tokenHash: USDC_HASH, value: 500n, random: 'bb'.repeat(16), notePublicKey: 8n, memo: 'thanks for lunch', senderShieldedAddress: '0zkSENDER' }),
      },
    );
    const hist = (st: WalletScanState) => reconstructHistory({
      ownedTxos: st.ownedTxos(), spentNullifiers: st.spentNullifiers(), unshields: st.unshieldEvents(), sentOutputs: st.sentOutputs(),
      shieldRelayerFees: st.shieldRelayerFees(), nullifyingKey: NK, shieldedAddress: '0zkME',
      resolveToken: () => '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', usdcHash: USDC_HASH,
    });
    const live = hist(state);
    const restored = hist(WalletScanState.restore(JSON.parse(JSON.stringify(state.snapshot()))));
    console.log('live    ', live.map((e) => ({ c: e.category, memo: e.memo, sender: e.senderShieldedAddress, shieldFee: e.shieldFee })));
    console.log('restored', restored.map((e) => ({ c: e.category, memo: e.memo, sender: e.senderShieldedAddress, shieldFee: e.shieldFee })));
    expect(live.find((e) => e.category === 'transfer-received')?.memo).toBe('thanks for lunch');
    expect(restored.find((e) => e.category === 'transfer-received')?.memo).toBeUndefined();
    expect(live.find((e) => e.category === 'shield')?.shieldFee).toBe(3n);
    expect(restored.find((e) => e.category === 'shield')?.shieldFee).toBeUndefined();
    expect(restored.find((e) => e.category === 'transfer-received')?.senderShieldedAddress).toBeUndefined();
    // selfMetadata rides on the change-note memo → same loss path (memo not persisted).
    expect(selfMeta.length).toBeGreaterThan(0);
  });
});
