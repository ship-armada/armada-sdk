// ABOUTME: Pure merkle hash math lifted from the engine's merkletree/merkletree.ts.
// ABOUTME: DIVERGES FROM UPSTREAM: only the tree-agnostic hash is kept here; the tree-building/DB-sync
// ABOUTME: orchestration in merkletree.ts is dropped as ABOVE_CORE (rebuilt in the SDK's sync layer).

import { poseidonHex } from '../utils/poseidon';

// hashLeftRight(left, right) = Poseidon(left, right) over the pinned BN254 field — the merkle node
// combiner used to build proofs and roots. Verbatim from Merkletree.hashLeftRight.
export const hashLeftRight = (left: string, right: string): string => poseidonHex([left, right]);
