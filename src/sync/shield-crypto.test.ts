// ABOUTME: Round-trip + negative tests for shield-note ownership decryption (§4.4): a shield serialized
// ABOUTME: to a receiver is claimed by that receiver, rejected for a stranger, and flows through the scan state.

import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise, getTokenDataERC20, getTokenDataHash, ShieldNote, type TokenData } from '../core/index';
import { deriveKeyset, type Keyset } from '../wallet/derive';
import { tryDecryptShield } from './shield-crypto';
import { WalletScanState } from './scan-engine';
import type { DecodedShieldCommitment } from './event-decoder';

const TXID = '0x' + 'cd'.repeat(32);
const RANDOM = 'ab'.repeat(16); // 16-byte note random
const strip0x = (h: string): string => (h.startsWith('0x') ? h.slice(2) : h);

// ShieldNote is abstract with no abstract members — a trivial subclass is instantiable for serialization.
class TestShieldNote extends ShieldNote {}

const receiverKeys = (k: Keyset) => ({
  addressData: { masterPublicKey: k.masterPublicKey, viewingPublicKey: k.viewingPublicKey },
  viewingPrivateKey: k.viewingPrivateKey,
});

describe('shield-note ownership decryption (§4.4)', () => {
  let receiver: Keyset;
  let stranger: Keyset;
  let tokenData: TokenData;
  const value = 1_000_000n;
  const shieldPrivateKey = new Uint8Array(32).fill(0x09); // ephemeral shield key

  // Build a shield serialized to `receiver`, shaped as the decoder would emit it.
  async function makeShieldCommitment(to: Keyset): Promise<DecodedShieldCommitment> {
    const note = new TestShieldNote(to.masterPublicKey, RANDOM, value, tokenData);
    const req = await note.serialize(shieldPrivateKey, to.viewingPublicKey);
    return {
      tree: 0,
      position: 0,
      blockNumber: 100,
      txid: TXID,
      hash: strip0x(req.preimage.npk as string), // placeholder leaf (not read by decrypt)
      npk: strip0x(req.preimage.npk as string),
      tokenData,
      value,
      encryptedBundle: [
        strip0x(req.ciphertext.encryptedBundle[0] as string),
        strip0x(req.ciphertext.encryptedBundle[1] as string),
        strip0x(req.ciphertext.encryptedBundle[2] as string),
      ],
      shieldKey: strip0x(req.ciphertext.shieldKey as string),
    };
  }

  beforeAll(async () => {
    await initPoseidonPromise;
    receiver = await deriveKeyset(new Uint8Array(32).fill(0x22));
    stranger = await deriveKeyset(new Uint8Array(32).fill(0x33));
    tokenData = getTokenDataERC20('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  });

  it('claims a shield serialized to the receiver (value + canonical tokenHash)', async () => {
    const commitment = await makeShieldCommitment(receiver);
    const owned = await tryDecryptShield(commitment, receiverKeys(receiver));
    expect(owned).toBeDefined();
    expect(owned!.value).toBe(value);
    expect(owned!.tokenHash).toBe(getTokenDataHash(tokenData));
  });

  it('does not claim a shield for a stranger', async () => {
    const commitment = await makeShieldCommitment(receiver);
    const owned = await tryDecryptShield(commitment, receiverKeys(stranger));
    expect(owned).toBeUndefined();
  });

  it('flows through the scan orchestrator as an owned TXO (fills the shield seam)', async () => {
    const commitment = await makeShieldCommitment(receiver);
    const state = new WalletScanState();
    await state.apply(
      { shields: [commitment], transacts: [], nullifiers: [], unshields: [] },
      {
        transact: async () => undefined,
        shield: (c) => tryDecryptShield(c, receiverKeys(receiver)),
      },
    );
    expect(state.txoCount).toBe(1);
    expect(state.treeLength(0)).toBe(1);
    expect(state.balances(receiver.nullifyingKey, { currentBlock: 200, finalityThreshold: 10 })).toEqual([
      { tokenHash: getTokenDataHash(tokenData), spendable: value, pending: 0n },
    ]);
  });
});
