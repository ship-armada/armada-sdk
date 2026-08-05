// ABOUTME: Tests for buildTransactCalldata (§4.6) — roundtrips through decodeTransact, verifies the
// ABOUTME: on-chain G2 coordinate swap, unshield preimage, and note-ciphertext survival.

import { describe, it, expect, beforeAll } from 'vitest';
import { Interface } from 'ethers';
import { initPoseidonPromise, getTokenDataERC20, TransactNote, type TokenData } from '../core/index';
import { deriveKeyset, type Keyset } from '../wallet/derive';
import { createTransferNote, encryptNoteToReceiver, tryDecryptCommitment, type CommitmentCiphertextV2 } from '../sync/index';
import { buildTransactCalldata, type TransactionData, type TransactionBoundParams } from './serialize';
import { decodeTransact, TRANSACT_ABI } from './decode';
import type { Groth16Proof } from '../prover/index';

const POOL = '0x00000000000000000000000000000000000000aa' as const;
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;

// Distinct coords so the swap is observable.
const PROOF: Groth16Proof = {
  a: ['1', '2'],
  b: [['3', '4'], ['5', '6']],
  c: ['7', '8'],
};

const bp = (cts: CommitmentCiphertextV2[]): TransactionBoundParams => ({
  treeNumber: 3,
  minGasPrice: 1_000_000n,
  unshield: 0,
  chainID: 31337n,
  adaptContract: '0x0000000000000000000000000000000000000000',
  adaptParams: `0x${'00'.repeat(32)}`,
  commitmentCiphertext: cts,
});

describe('buildTransactCalldata (§4.6)', () => {
  const iface = new Interface(TRANSACT_ABI as unknown as string[]);
  let sender: Keyset;
  let receiver: Keyset;
  let tokenData: TokenData;

  beforeAll(async () => {
    await initPoseidonPromise;
    sender = await deriveKeyset(new Uint8Array(32).fill(0x11));
    receiver = await deriveKeyset(new Uint8Array(32).fill(0x22));
    tokenData = getTokenDataERC20(USDC);
  });

  async function makeCt(value: bigint): Promise<{ note: TransactNote; ct: CommitmentCiphertextV2 }> {
    const note = createTransferNote({
      receiverAddressData: { masterPublicKey: receiver.masterPublicKey, viewingPublicKey: receiver.viewingPublicKey },
      senderAddressData: { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey },
      value, tokenData,
    });
    const ct = await encryptNoteToReceiver(
      note,
      { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey, viewingPrivateKey: sender.viewingPrivateKey },
      receiver.viewingPublicKey,
    );
    return { note, ct };
  }

  it('roundtrips a transaction through decodeTransact', async () => {
    const { note, ct } = await makeCt(500_000n);
    const tx: TransactionData = {
      proof: PROOF, merkleRoot: 777n, nullifiers: [11n, 12n], commitments: [note.hash], boundParams: bp([ct]),
    };
    const { to, data, value } = buildTransactCalldata([tx], POOL);
    expect(to).toBe(POOL);
    expect(value).toBe(0n);

    const [decoded] = decodeTransact(data);
    expect(decoded!.merkleRoot).toBe(777n);
    expect(decoded!.nullifiers).toEqual([11n, 12n]);
    expect(decoded!.commitments).toEqual([note.hash]);
    expect(decoded!.boundParams.treeNumber).toBe(3);
    expect(decoded!.boundParams.chainID).toBe(31337n);
    expect(decoded!.commitmentCiphertexts).toHaveLength(1);
  });

  it('applies the on-chain G2 coordinate swap to the proof', async () => {
    const { note, ct } = await makeCt(1n);
    const tx: TransactionData = { proof: PROOF, merkleRoot: 1n, nullifiers: [9n], commitments: [note.hash], boundParams: bp([ct]) };
    const { data } = buildTransactCalldata([tx], POOL);

    const [transactions] = iface.decodeFunctionData('transact', data) as unknown as [Array<{ proof: [bigint[], bigint[][], bigint[]] }>];
    const proof = transactions[0]!.proof;
    expect(proof[0]).toEqual([1n, 2n]); // a unchanged
    expect(proof[1][0]).toEqual([4n, 3n]); // b.x swapped from [3,4]
    expect(proof[1][1]).toEqual([6n, 5n]); // b.y swapped from [5,6]
    expect(proof[2]).toEqual([7n, 8n]); // c unchanged
  });

  it('preserves note ciphertexts (decoded fee note decrypts back)', async () => {
    const value = 42_000n;
    const { note, ct } = await makeCt(value);
    const tx: TransactionData = { proof: PROOF, merkleRoot: 1n, nullifiers: [9n], commitments: [note.hash], boundParams: bp([ct]) };
    const { data } = buildTransactCalldata([tx], POOL);

    const [decoded] = decodeTransact(data);
    const recovered = await tryDecryptCommitment(
      decoded!.commitmentCiphertexts[0]!,
      { addressData: { masterPublicKey: receiver.masterPublicKey, viewingPublicKey: receiver.viewingPublicKey }, viewingPrivateKey: receiver.viewingPrivateKey },
      { getTokenDataFromHash: async () => tokenData },
    );
    expect(recovered?.value).toBe(value);
  });

  it('serializes an unshield preimage', async () => {
    const { note, ct } = await makeCt(1n);
    const tx: TransactionData = {
      proof: PROOF, merkleRoot: 1n, nullifiers: [9n], commitments: [note.hash],
      boundParams: { ...bp([ct]), unshield: 1 },
      unshieldPreimage: { npk: 123n, tokenType: 0, tokenAddress: USDC, tokenSubID: 0n, value: 250_000n },
    };
    const { data } = buildTransactCalldata([tx], POOL);
    const [decoded] = decodeTransact(data);
    expect(decoded!.unshieldPreimage).toBeDefined();
    expect(decoded!.unshieldPreimage!.value).toBe(250_000n);
    expect(decoded!.unshieldPreimage!.tokenAddress.toLowerCase()).toBe(USDC);
  });

  it('serializes a multi-transaction bundle', async () => {
    const a = await makeCt(10n);
    const b = await makeCt(20n);
    const mk = (note: TransactNote, ct: CommitmentCiphertextV2): TransactionData => ({
      proof: PROOF, merkleRoot: 1n, nullifiers: [9n], commitments: [note.hash], boundParams: bp([ct]),
    });
    const { data } = buildTransactCalldata([mk(a.note, a.ct), mk(b.note, b.ct)], POOL);
    const decoded = decodeTransact(data);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]!.commitments).toEqual([a.note.hash]);
    expect(decoded[1]!.commitments).toEqual([b.note.hash]);
  });
});
