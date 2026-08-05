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
