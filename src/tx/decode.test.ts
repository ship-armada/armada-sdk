// ABOUTME: Tests for decodeTransact (§4.6) — ethers-encoded transact() calldata round-trips into
// ABOUTME: DecodedTransact, including note-ciphertext survival (decrypts back) and unshield-preimage handling.

import { describe, it, expect, beforeAll } from 'vitest';
import { Interface, ZeroAddress } from 'ethers';
import { initPoseidonPromise, getTokenDataERC20, TransactNote, type TokenData } from '../core/index';
import { deriveKeyset, type Keyset } from '../wallet/derive';
import { createTransferNote, encryptNoteToReceiver, tryDecryptCommitment, type CommitmentCiphertextV2 } from '../sync/index';
import { decodeTransact, extractFeeOutput, TRANSACT_ABI } from './decode';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const b32 = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0');
const bytesToHex = (b: Uint8Array): string => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// Encode a CommitmentCiphertextV2 back into the on-chain struct tuple ethers expects.
const ctTuple = (c: CommitmentCiphertextV2) => [
  c.ciphertext.map((x) => (x.startsWith('0x') ? x : `0x${x}`)),
  bytesToHex(c.blindedSenderViewingKey),
  bytesToHex(c.blindedReceiverViewingKey),
  c.annotationData.startsWith('0x') ? c.annotationData : `0x${c.annotationData}`,
  c.memo.startsWith('0x') ? c.memo : `0x${c.memo}`,
];

const ZERO_PROOF = [[0n, 0n], [[0n, 0n], [0n, 0n]], [0n, 0n]];
const ZERO_PREIMAGE = [b32(0n), [0, ZeroAddress, 0n], 0n];

describe('decodeTransact (§4.6)', () => {
  const iface = new Interface(TRANSACT_ABI as unknown as string[]);
  let sender: Keyset;
  let receiver: Keyset;
  let broadcaster: Keyset;
  let tokenData: TokenData;

  beforeAll(async () => {
    await initPoseidonPromise;
    sender = await deriveKeyset(new Uint8Array(32).fill(0x11));
    receiver = await deriveKeyset(new Uint8Array(32).fill(0x22));
    broadcaster = await deriveKeyset(new Uint8Array(32).fill(0x33));
    tokenData = getTokenDataERC20(USDC);
  });

  async function makeCommitment(value: bigint, rcv: Keyset = receiver): Promise<{ note: TransactNote; ct: CommitmentCiphertextV2 }> {
    const note = createTransferNote({
      receiverAddressData: { masterPublicKey: rcv.masterPublicKey, viewingPublicKey: rcv.viewingPublicKey },
      senderAddressData: { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey },
      value,
      tokenData,
    });
    const ct = await encryptNoteToReceiver(
      note,
      { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey, viewingPrivateKey: sender.viewingPrivateKey },
      rcv.viewingPublicKey,
    );
    return { note, ct };
  }

  // Assemble a transact() calldata over explicit commitments + output ciphertexts.
  const buildCalldata = (commitments: bigint[], cts: CommitmentCiphertextV2[]): string => {
    const transaction = [
      ZERO_PROOF, b32(1n), [b32(9n)], commitments.map(b32),
      [0, 0n, 0, 31337, ZeroAddress, b32(0n), cts.map(ctTuple)],
      ZERO_PREIMAGE,
    ];
    return iface.encodeFunctionData('transact', [[transaction]]);
  };
  const rk = (k: Keyset) => ({
    addressData: { masterPublicKey: k.masterPublicKey, viewingPublicKey: k.viewingPublicKey },
    viewingPrivateKey: k.viewingPrivateKey,
  });
  const tokenGetter = () => ({ getTokenDataFromHash: async () => tokenData });

  it('decodes a transact() calldata into structured fields', async () => {
    const { note, ct } = await makeCommitment(500_000n);
    const transaction = [
      ZERO_PROOF,
      b32(777n), // merkleRoot
      [b32(11n), b32(12n)], // nullifiers
      [b32(note.hash)], // commitments
      [3, 1_000_000n, 0 /* UnshieldType.NONE */, 31337, ZeroAddress, b32(0n), [ctTuple(ct)]],
      ZERO_PREIMAGE,
    ];
    const calldata = iface.encodeFunctionData('transact', [[transaction]]);

    const decoded = decodeTransact(calldata);
    expect(decoded).toHaveLength(1);
    const d = decoded[0]!;
    expect(d.merkleRoot).toBe(777n);
    expect(d.nullifiers).toEqual([11n, 12n]);
    expect(d.commitments).toEqual([note.hash]);
    expect(d.boundParams.treeNumber).toBe(3);
    expect(d.boundParams.minGasPrice).toBe(1_000_000n);
    expect(d.boundParams.chainID).toBe(31337n);
    expect(d.boundParams.unshield).toBe(0);
    expect(d.commitmentCiphertexts).toHaveLength(1);
    expect(d.unshieldPreimage).toBeUndefined();
  });

  it('preserves note ciphertexts through the round-trip (decoded fee note decrypts back)', async () => {
    const value = 42_000n;
    const { note, ct } = await makeCommitment(value);
    const transaction = [
      ZERO_PROOF, b32(1n), [b32(9n)], [b32(note.hash)],
      [0, 0n, 0, 31337, ZeroAddress, b32(0n), [ctTuple(ct)]],
      ZERO_PREIMAGE,
    ];
    const calldata = iface.encodeFunctionData('transact', [[transaction]]);

    const d = decodeTransact(calldata)[0]!;
    const tokenDataGetter = { getTokenDataFromHash: async () => tokenData };
    const recovered = await tryDecryptCommitment(
      d.commitmentCiphertexts[0]!,
      { addressData: { masterPublicKey: receiver.masterPublicKey, viewingPublicKey: receiver.viewingPublicKey }, viewingPrivateKey: receiver.viewingPrivateKey },
      tokenDataGetter,
    );
    expect(recovered).toBeDefined();
    expect(recovered!.value).toBe(value);
    expect(recovered!.tokenHash).toBe(note.tokenHash);
  });

  it('surfaces the unshield preimage only when unshield != NONE', async () => {
    const { note, ct } = await makeCommitment(1n);
    const preimage = [b32(123n), [0, USDC, 0n], 250_000n];
    const transaction = [
      ZERO_PROOF, b32(1n), [b32(9n)], [b32(note.hash)],
      [0, 0n, 1 /* UnshieldType.NORMAL */, 31337, ZeroAddress, b32(0n), [ctTuple(ct)]],
      preimage,
    ];
    const calldata = iface.encodeFunctionData('transact', [[transaction]]);

    const d = decodeTransact(calldata)[0]!;
    expect(d.unshieldPreimage).toBeDefined();
    expect(d.unshieldPreimage!.value).toBe(250_000n);
    expect(d.unshieldPreimage!.tokenAddress.toLowerCase()).toBe(USDC);
    expect(d.unshieldPreimage!.npk).toBe(123n);
  });

  it('decodes a multi-transaction bundle into one entry each', async () => {
    const a = await makeCommitment(10n);
    const b = await makeCommitment(20n);
    const mk = (hash: bigint, ct: CommitmentCiphertextV2) => [
      ZERO_PROOF, b32(1n), [b32(9n)], [b32(hash)],
      [0, 0n, 0, 31337, ZeroAddress, b32(0n), [ctTuple(ct)]],
      ZERO_PREIMAGE,
    ];
    const calldata = iface.encodeFunctionData('transact', [[mk(a.note.hash, a.ct), mk(b.note.hash, b.ct)]]);

    const decoded = decodeTransact(calldata);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]!.commitments).toEqual([a.note.hash]);
    expect(decoded[1]!.commitments).toEqual([b.note.hash]);
  });

  it('extractFeeOutput recovers the fee note addressed to the broadcaster', async () => {
    const fee = 5_000n;
    const feeNote = await makeCommitment(fee, broadcaster);
    const other = await makeCommitment(3n, receiver); // an ordinary output not ours
    const calldata = buildCalldata([feeNote.note.hash, other.note.hash], [feeNote.ct, other.ct]);

    const [decoded] = decodeTransact(calldata);
    const result = await extractFeeOutput(decoded!, rk(broadcaster), tokenGetter());
    expect(result).toBeDefined();
    expect(result!.value).toBe(fee);
    expect(result!.tokenAddress.toLowerCase()).toBe(USDC);
  });

  it('extractFeeOutput returns undefined for a wallet that owns no output', async () => {
    const feeNote = await makeCommitment(5_000n, broadcaster);
    const calldata = buildCalldata([feeNote.note.hash], [feeNote.ct]);
    const [decoded] = decodeTransact(calldata);
    // `receiver` is not the broadcaster — cannot decrypt the fee note.
    expect(await extractFeeOutput(decoded!, rk(receiver), tokenGetter())).toBeUndefined();
  });

  it('extractFeeOutput rejects a decryptable ciphertext whose commitment is not in the tx (binding)', async () => {
    // The broadcaster CAN decrypt this ciphertext, but its commitment is absent from commitments[] —
    // a forged fee claim. Binding to an actual commitment must reject it.
    const feeNote = await makeCommitment(9_999n, broadcaster);
    const calldata = buildCalldata([0xdeadn], [feeNote.ct]); // commitment != feeNote.hash
    const [decoded] = decodeTransact(calldata);
    expect(await extractFeeOutput(decoded!, rk(broadcaster), tokenGetter())).toBeUndefined();
  });

  it('extractFeeOutput enforces the optional expected token + minimum value (P3.7 guard)', async () => {
    // WHY: a relayer verifies the fee note is in the right token AND ≥ the advertised amount. Passing
    // `expected` makes the SDK do the comparison so the call site can't forget it.
    const fee = 5_000n;
    const feeNote = await makeCommitment(fee, broadcaster);
    const calldata = buildCalldata([feeNote.note.hash], [feeNote.ct]);
    const [decoded] = decodeTransact(calldata);

    // Matches token + meets the minimum → returned.
    expect(
      await extractFeeOutput(decoded!, rk(broadcaster), tokenGetter(), undefined, { tokenAddress: USDC as `0x${string}`, minValue: fee }),
    ).toEqual({ tokenAddress: USDC, value: fee });
    // Underpaid (advertised fee higher than the note) → skipped.
    expect(
      await extractFeeOutput(decoded!, rk(broadcaster), tokenGetter(), undefined, { minValue: fee + 1n }),
    ).toBeUndefined();
    // Wrong expected token → skipped.
    expect(
      await extractFeeOutput(decoded!, rk(broadcaster), tokenGetter(), undefined, { tokenAddress: `0x${'22'.repeat(20)}` }),
    ).toBeUndefined();
  });
});
