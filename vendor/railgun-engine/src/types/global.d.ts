declare type Optional<T> = T | undefined;

declare module '@railgun-community/circomlibjs' {
  export type Signature = {
    R8: [bigint, bigint];
    S: bigint;
  };
  export namespace eddsa {
    export function verifyPoseidon(msg: bigint, sig: Signature, A: bigint[]): boolean;
    export function signPoseidon(prv: Uint8Array, msg: bigint): Signature;
    export function prv2pub(prv: Buffer): [bigint, bigint];
  }
  export namespace babyjub {
    export function packPoint(point: [bigint, bigint]): Buffer;
    export function unpackPoint(buffer: Buffer): [bigint, bigint];
  }
  export function poseidon(inputs: bigint[]): bigint;
}

// DIVERGES FROM UPSTREAM: the engine imports these circomlibjs modules directly, not through its index (see
// utils/poseidon.ts); same members as the index's namespaces above.
declare module '@railgun-community/circomlibjs/src/eddsa' {
  import type { Signature } from '@railgun-community/circomlibjs';
  export function verifyPoseidon(msg: bigint, sig: Signature, A: bigint[]): boolean;
  export function signPoseidon(prv: Uint8Array, msg: bigint): Signature;
  export function prv2pub(prv: Buffer): [bigint, bigint];
}
declare module '@railgun-community/circomlibjs/src/babyjub' {
  export function packPoint(point: [bigint, bigint]): Buffer;
  export function unpackPoint(buffer: Buffer): [bigint, bigint];
}
declare module '@railgun-community/circomlibjs/src/poseidon' {
  function poseidon(inputs: bigint[]): bigint;
  export = poseidon;
}

declare type Artifact = {
  zkey: ArrayLike<number>;
  wasm: Optional<ArrayLike<number>>;
  dat: Optional<ArrayLike<number>>;
  vkey: object;
};

// declare module 'railgun-community-circuit-artifacts' {
//   type ArtifactListMetadata = {
//     nullifiers: number;
//     commitments: number;
//   }[];

//   export function getArtifact(nullifiers: number, commitments: number): Artifact;

//   export function getVKey(nullifiers: number, commitments: number): string;

//   export function listArtifacts(): ArtifactListMetadata;
// }

declare module 'snarkjs';

declare module 'hash-emoji';

// DIVERGES FROM UPSTREAM: ambient declaration for buffer-xor (ships no type declarations).
declare module 'buffer-xor';
