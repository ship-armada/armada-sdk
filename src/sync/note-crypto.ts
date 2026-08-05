// ABOUTME: Note ECIES V2 codec — encrypt a TransactNote to a receiver (send) and trial-decrypt an
// ABOUTME: on-chain commitment ciphertext with a viewing key (scan). Closes the note-ciphertext primitive (SPEC §4.4).

import {
  TransactNote,
  OutputType,
  TXIDVersion,
  ChainType,
  getNoteBlindingKeys,
  getSharedSymmetricKey,
  WalletInfo,
  type AddressData,
  type TokenData,
  type Ciphertext,
  type Chain,
  type TokenDataGetter,
} from '../core/index';

/**
 * On-chain V2 commitment ciphertext (the shape emitted by the pool's Transact event, per the captured
 * `note-ciphertext-vectors.json`). `ciphertext[0]` is the AES iv+tag (16+16 bytes) concatenated; the
 * remaining three are the AES data blocks. Hex may be 0x-prefixed (as on-chain) or bare.
 */
export interface CommitmentCiphertextV2 {
  readonly ciphertext: readonly string[]; // [ivTag, data0, data1, data2]
  readonly blindedSenderViewingKey: Uint8Array;
  readonly blindedReceiverViewingKey: Uint8Array;
  readonly memo: string;
  readonly annotationData: string;
}

/** Sender key material needed to encrypt a note (masterPublicKey encodes sender visibility). */
export interface SenderNoteKeys {
  readonly masterPublicKey: bigint;
  readonly viewingPublicKey: Uint8Array;
  readonly viewingPrivateKey: Uint8Array;
}

/** Receiver key material needed to trial-decrypt a commitment. */
export interface ReceiverNoteKeys {
  readonly addressData: AddressData; // { masterPublicKey, viewingPublicKey }
  readonly viewingPrivateKey: Uint8Array;
}

// Browser-safe 0x strip (core does not re-export ByteUtils; keep this bundlable without polyfills).
function strip0x(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}

/** Default EVM chain descriptor for V2 note decryption (only NFT paths read chain; ERC20 ignores it). */
export const DEFAULT_EVM_CHAIN: Chain = { type: ChainType.EVM, id: 1 };

/**
 * Build a transfer note with the wallet-source tag set (required for V2 annotation data). Sender
 * address is hidden by default (`showSenderAddressToRecipient=false`), matching the privacy default.
 */
export function createTransferNote(params: {
  receiverAddressData: AddressData;
  senderAddressData?: AddressData;
  value: bigint;
  tokenData: TokenData;
  memoText?: string;
  showSenderAddressToRecipient?: boolean;
}): TransactNote {
  // annotation data (created inside encryptV2) requires a wallet source to be set.
  WalletInfo.setWalletSource('armada');
  return TransactNote.createTransfer(
    params.receiverAddressData,
    params.senderAddressData,
    params.value,
    params.tokenData,
    params.showSenderAddressToRecipient ?? false,
    OutputType.Transfer,
    params.memoText,
  );
}

/**
 * Send side: encrypt `note` to its receiver, producing the on-chain commitment ciphertext. Replicates
 * the engine's exact ECIES sequence — blind viewing keys (`getNoteBlindingKeys`), derive the shared
 * symmetric key by ECDH against the blinded *receiver* key, then AES-256-GCM via `encryptV2`.
 */
export async function encryptNoteToReceiver(
  note: TransactNote,
  sender: SenderNoteKeys,
  receiverViewingPublicKey: Uint8Array,
): Promise<CommitmentCiphertextV2> {
  if (note.senderRandom === undefined) {
    throw new Error('encryptNoteToReceiver: note.senderRandom must be set (use createTransferNote)');
  }
  const { blindedSenderViewingKey, blindedReceiverViewingKey } = getNoteBlindingKeys(
    sender.viewingPublicKey,
    receiverViewingPublicKey,
    note.random,
    note.senderRandom,
  );
  const sharedKey = await getSharedSymmetricKey(sender.viewingPrivateKey, blindedReceiverViewingKey);
  if (sharedKey === undefined) {
    throw new Error('encryptNoteToReceiver: failed to derive shared symmetric key');
  }
  const { noteCiphertext, noteMemo, annotationData } = note.encryptV2(
    TXIDVersion.V2_PoseidonMerkle,
    sharedKey,
    sender.masterPublicKey,
    note.senderRandom,
    sender.viewingPrivateKey,
  );
  const ivTag = `${noteCiphertext.iv}${noteCiphertext.tag}`;
  return {
    ciphertext: [ivTag, ...noteCiphertext.data],
    blindedSenderViewingKey,
    blindedReceiverViewingKey,
    memo: noteMemo,
    annotationData,
  };
}

/** Split the packed on-chain ciphertext array back into the AES `{ iv, tag, data }` envelope. */
function unpackCiphertext(packed: readonly string[]): Ciphertext {
  if (packed.length !== 4) {
    throw new Error(`unpackCiphertext: expected 4 elements, got ${packed.length}`);
  }
  // Non-null assertions are safe: the length check above guarantees indices 0..3 are present.
  const ivTag = strip0x(packed[0]!);
  return {
    iv: ivTag.substring(0, 32),
    tag: ivTag.substring(32, 64),
    data: [strip0x(packed[1]!), strip0x(packed[2]!), strip0x(packed[3]!)],
  };
}

/**
 * Scan side: try to decrypt a commitment as a note received by `receiver`. Derives the shared key by
 * ECDH against the blinded *sender* key (the mirror of the send direction), then runs the engine's V2
 * decrypt. Returns `undefined` if the commitment is not ours (shared-key or AES-GCM auth failure) —
 * the sync engine calls this for every commitment and keeps the ones that decrypt.
 */
export async function tryDecryptCommitment(
  commitment: CommitmentCiphertextV2,
  receiver: ReceiverNoteKeys,
  tokenDataGetter: TokenDataGetter,
  chain: Chain = DEFAULT_EVM_CHAIN,
): Promise<TransactNote | undefined> {
  const sharedKey = await getSharedSymmetricKey(
    receiver.viewingPrivateKey,
    commitment.blindedSenderViewingKey,
  );
  if (sharedKey === undefined) {
    return undefined;
  }
  try {
    return await TransactNote.decrypt(
      TXIDVersion.V2_PoseidonMerkle,
      chain,
      receiver.addressData,
      unpackCiphertext(commitment.ciphertext),
      sharedKey,
      commitment.memo,
      commitment.annotationData,
      receiver.viewingPrivateKey,
      commitment.blindedReceiverViewingKey,
      commitment.blindedSenderViewingKey,
      false, // isSentNote — receive-side trial decrypt
      false, // isLegacyDecryption
      tokenDataGetter,
      undefined, // blockNumber
      undefined, // transactCommitmentBatchIndexV3 (V2 unused)
    );
  } catch {
    // AES-GCM auth failure / not-ours — expected for commitments belonging to other wallets.
    return undefined;
  }
}
