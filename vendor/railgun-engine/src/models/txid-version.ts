// ABOUTME: TXIDVersion enum + active-version constants, lifted verbatim from the engine's original
// ABOUTME: poi-types module. DIVERGES FROM UPSTREAM: extracted here so the pinned core can import
// ABOUTME: TXIDVersion without the proof-of-innocence types (that module is dropped, SPEC §3.5).

export enum TXIDVersion {
  V2_PoseidonMerkle = 'V2_PoseidonMerkle',
  V3_PoseidonMerkle = 'V3_PoseidonMerkle',
  // V3_KZG = 'V3_KZG',
}

export const ACTIVE_UTXO_MERKLETREE_TXID_VERSIONS: TXIDVersion[] = [
  TXIDVersion.V2_PoseidonMerkle,
  TXIDVersion.V3_PoseidonMerkle,
];

export const ACTIVE_TXID_VERSIONS: TXIDVersion[] = [
  TXIDVersion.V2_PoseidonMerkle,
  TXIDVersion.V3_PoseidonMerkle,
];
