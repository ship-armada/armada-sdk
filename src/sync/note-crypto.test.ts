// ABOUTME: Round-trip + negative tests for the note ECIES V2 codec (encrypt→decrypt). Closes the
// ABOUTME: deferred note-ciphertext primitive: a note encrypted to a receiver decrypts back byte-identically.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initPoseidonPromise, getTokenDataERC20, type AddressData, type TokenData } from '../core/index';
import { deriveKeyset, type Keyset } from '../wallet/derive';
import {
  createTransferNote,
  encryptNoteToReceiver,
  tryDecryptCommitment,
  tryDecryptSentCommitment,
  type SenderNoteKeys,
  type ReceiverNoteKeys,
} from './note-crypto';

// Fixed test seeds — three distinct wallets (sender, receiver, stranger).
const seed = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

// A valid 20-byte ERC20 address (USDC mainnet) — arbitrary; only its token hash matters here.
const TOKEN_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

const senderKeys = (k: Keyset): SenderNoteKeys => ({
  masterPublicKey: k.masterPublicKey,
  viewingPublicKey: k.viewingPublicKey,
  viewingPrivateKey: k.viewingPrivateKey,
});
const receiverKeys = (k: Keyset): ReceiverNoteKeys => ({
  addressData: { masterPublicKey: k.masterPublicKey, viewingPublicKey: k.viewingPublicKey },
  viewingPrivateKey: k.viewingPrivateKey,
});

describe('note ECIES V2 codec (§4.4)', () => {
  let sender: Keyset;
  let receiver: Keyset;
  let stranger: Keyset;
  let tokenData: TokenData;
  // A getter resolving the single known token — the sync engine supplies a registry-backed one.
  let tokenDataGetter: { getTokenDataFromHash: () => Promise<TokenData> };

  beforeAll(async () => {
    await initPoseidonPromise;
    sender = await deriveKeyset(seed(0x11));
    receiver = await deriveKeyset(seed(0x22));
    stranger = await deriveKeyset(seed(0x33));
    tokenData = getTokenDataERC20(TOKEN_ADDRESS);
    tokenDataGetter = { getTokenDataFromHash: async () => tokenData };
  });

  it('round-trips: a note encrypted to a receiver decrypts back to the same note', async () => {
    const value = 1234567890n;
    const senderAddressData: AddressData = {
      masterPublicKey: sender.masterPublicKey,
      viewingPublicKey: sender.viewingPublicKey,
    };
    const note = createTransferNote({
      receiverAddressData: { masterPublicKey: receiver.masterPublicKey, viewingPublicKey: receiver.viewingPublicKey },
      senderAddressData,
      value,
      tokenData,
    });

    const commitment = await encryptNoteToReceiver(note, senderKeys(sender), receiver.viewingPublicKey);
    const decrypted = await tryDecryptCommitment(commitment, receiverKeys(receiver), tokenDataGetter);

    expect(decrypted).toBeDefined();
    // The three note-defining fields must survive the ECIES round-trip exactly.
    expect(decrypted!.notePublicKey).toEqual(note.notePublicKey);
    expect(decrypted!.value).toEqual(value);
    expect(decrypted!.tokenHash).toEqual(note.tokenHash);
    // notePublicKey binds to the RECEIVER's master public key.
    expect(decrypted!.receiverAddressData.masterPublicKey).toEqual(receiver.masterPublicKey);
  });

  it('produces the on-chain commitment shape (packed ivTag + 3 data blocks, 32-byte blinded keys)', async () => {
    const note = createTransferNote({
      receiverAddressData: { masterPublicKey: receiver.masterPublicKey, viewingPublicKey: receiver.viewingPublicKey },
      senderAddressData: { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey },
      value: 42n,
      tokenData,
    });
    const commitment = await encryptNoteToReceiver(note, senderKeys(sender), receiver.viewingPublicKey);

    // Matches the captured note-ciphertext-vectors.json envelope: 4 bytes32 + two 32-byte blinded keys.
    expect(commitment.ciphertext).toHaveLength(4);
    expect(commitment.ciphertext[0]).toHaveLength(64); // ivTag = iv(16B) + tag(16B)
    for (const block of commitment.ciphertext.slice(1)) expect(block).toHaveLength(64);
    expect(commitment.blindedSenderViewingKey).toHaveLength(32);
    expect(commitment.blindedReceiverViewingKey).toHaveLength(32);
  });

  it('does not decrypt for a stranger (shared-key / AES-GCM mismatch → undefined)', async () => {
    const note = createTransferNote({
      receiverAddressData: { masterPublicKey: receiver.masterPublicKey, viewingPublicKey: receiver.viewingPublicKey },
      senderAddressData: { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey },
      value: 999n,
      tokenData,
    });
    const commitment = await encryptNoteToReceiver(note, senderKeys(sender), receiver.viewingPublicKey);

    const wrong = await tryDecryptCommitment(commitment, receiverKeys(stranger), tokenDataGetter);
    expect(wrong).toBeUndefined();
  });

  it('matches the captured on-chain ciphertext envelope shape (note-ciphertext-vectors.json)', () => {
    // Structural parity with a real stock-engine capture (0x-prefixed bytes32[4] + blinded keys).
    const fixturePath = fileURLToPath(new URL('../../test/vectors/note-ciphertext-vectors.json', import.meta.url));
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      commitmentCiphertext: Array<{
        ciphertext: string[];
        blindedSenderViewingKey: string;
        blindedReceiverViewingKey: string;
      }>;
    };
    for (const entry of fixture.commitmentCiphertext) {
      expect(entry.ciphertext).toHaveLength(4);
      for (const el of entry.ciphertext) expect(el).toMatch(/^0x[0-9a-f]{64}$/);
      expect(entry.blindedSenderViewingKey).toMatch(/^0x[0-9a-f]{64}$/);
      expect(entry.blindedReceiverViewingKey).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });

  it('sender recovers its OWN sent note via the viewing key (view-only send history, H3)', async () => {
    // WHY: a view-only wallet (viewing key only, no spend key) must see the shared identity's SENDS,
    // not just receives. Sender-side decryption recovers a note WE authored — recipient, value, memo —
    // using only the viewing key + the author-encrypted annotationData. This is what makes a shared
    // viewing key show full activity.
    const note = createTransferNote({
      receiverAddressData: { masterPublicKey: receiver.masterPublicKey, viewingPublicKey: receiver.viewingPublicKey },
      senderAddressData: { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey },
      value: 250_000n,
      tokenData,
      memoText: 'ty',
    });
    const commitment = await encryptNoteToReceiver(note, senderKeys(sender), receiver.viewingPublicKey);

    // The sender — or any view-only wallet holding the sender's viewing key — recovers it.
    const recovered = await tryDecryptSentCommitment(commitment, receiverKeys(sender), tokenDataGetter);
    expect(recovered).toBeDefined();
    expect(recovered!.value).toBe(250_000n);
    expect(recovered!.memoText).toBe('ty');
    // The recovered note points at the RECIPIENT (who we sent to).
    expect(recovered!.receiverAddressData.masterPublicKey).toBe(receiver.masterPublicKey);

    // A stranger's viewing key cannot recover our send.
    const byStranger = await tryDecryptSentCommitment(commitment, receiverKeys(stranger), tokenDataGetter);
    expect(byStranger).toBeUndefined();
    // Nor does the receive-side decryptor treat it as an incoming note for the sender.
    const asReceive = await tryDecryptCommitment(commitment, receiverKeys(sender), tokenDataGetter);
    expect(asReceive).toBeUndefined();
  });
});
