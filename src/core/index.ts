// ABOUTME: core/ — the PINNED, byte-compatible crypto core surface. Re-exports primitives adapted
// ABOUTME: from the vendored Railgun engine (SPEC §2/§3.2); byte-parity enforced by test/vectors.

// Poseidon(BN254) — the foundational hash. `initPoseidonPromise` must resolve before use (WASM init).
export { poseidon, poseidonHex, initPoseidonPromise } from '../../vendor/railgun-engine/dist/utils/poseidon';

// Notes: commitment hash `getHash(npk, tokenHash, value)` + `getNullifier(nullifyingKey, leafIndex)`.
export { TransactNote } from '../../vendor/railgun-engine/dist/note/transact-note';

// boundParams hashing (keccak(abi.encode) % SNARK field) for transact public inputs.
export { hashBoundParamsV2, hashBoundParamsV3 } from '../../vendor/railgun-engine/dist/transaction/bound-params';

// Merkle: proof verification + the node combiner (Poseidon left/right).
export { verifyMerkleProof, createDummyMerkleProof } from '../../vendor/railgun-engine/dist/merkletree/merkle-proof';
export { hashLeftRight } from '../../vendor/railgun-engine/dist/merkletree/merkle-math';
export { MERKLE_ZERO_VALUE, MERKLE_ZERO_VALUE_BIGINT, TREE_DEPTH } from '../../vendor/railgun-engine/dist/models/merkletree-types';

// Spend-authorization EdDSA (BabyJubjub) — verify a signature over the poseidon intent digest.
export { verifyEDDSA, signEDDSA, getPublicSpendingKey, getPublicViewingKey } from '../../vendor/railgun-engine/dist/utils/keys-utils';

// Note ECIES: viewing-key blinding + ECDH shared symmetric key for note ciphertext encrypt/decrypt.
export { getNoteBlindingKeys, getSharedSymmetricKey } from '../../vendor/railgun-engine/dist/utils/keys-utils';

// Token data helpers + note/tx enums used by the note ciphertext codec.
export { getTokenDataERC20, getTokenDataHash } from '../../vendor/railgun-engine/dist/note/note-util';
export { OutputType, TokenType } from '../../vendor/railgun-engine/dist/models/formatted-types';
export type { TokenData, Ciphertext } from '../../vendor/railgun-engine/dist/models/formatted-types';
export { ChainType } from '../../vendor/railgun-engine/dist/models/engine-types';
export type { Chain } from '../../vendor/railgun-engine/dist/models/engine-types';
export { TXIDVersion } from '../../vendor/railgun-engine/dist/models/txid-version';
export type { TokenDataGetter } from '../../vendor/railgun-engine/dist/note/transact-note';

// Wallet source tag — must be set before creating a transfer note (annotation-data requirement).
export { default as WalletInfo } from '../../vendor/railgun-engine/dist/wallet/wallet-info';

// Shield notes: ownership decryption (decryptRandom via shieldKey ECDH) + note-public-key/hash helpers.
export { ShieldNote } from '../../vendor/railgun-engine/dist/note/shield-note';

// Key derivation — mnemonic → wallet nodes → keypairs/masterPublicKey; 0zk address encode/decode.
export { Mnemonic } from '../../vendor/railgun-engine/dist/key-derivation/bip39';
export { deriveNodes, WalletNode } from '../../vendor/railgun-engine/dist/key-derivation/wallet-node';
export type { SpendingKeyPair, ViewingKeyPair, SpendingPublicKey } from '../../vendor/railgun-engine/dist/key-derivation/wallet-node';
export { encodeAddress, decodeAddress } from '../../vendor/railgun-engine/dist/key-derivation/bech32';
export type { AddressData } from '../../vendor/railgun-engine/dist/key-derivation/bech32';
