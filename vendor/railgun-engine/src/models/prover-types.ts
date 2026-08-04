import { PoseidonMerkleVerifier } from '../abi/typechain/PoseidonMerkleVerifier';
import { BoundParamsStruct } from '../abi/typechain/RailgunSmartWallet';
// eslint-disable-next-line import/no-cycle
import { TXIDVersion } from './txid-version';

export const enum Circuits {
  OneTwo,
  OneThree,
  TwoTwo,
  TwoThree,
  EightTwo,
}

export type G1Point = {
  x: bigint;
  y: bigint;
};
export type G2Point = {
  x: [bigint, bigint];
  y: [bigint, bigint];
};

export type SnarkProof = {
  a: G1Point;
  b: G2Point;
  c: G1Point;
};

export type Proof = {
  pi_a: [string, string];
  pi_b: [[string, string], [string, string]];
  pi_c: [string, string];
};

export type PublicInputsRailgun = {
  merkleRoot: bigint;
  boundParamsHash: bigint;
  nullifiers: bigint[];
  commitmentsOut: bigint[];
};

export type PrivateInputsRailgun = {
  tokenAddress: bigint;
  publicKey: [bigint, bigint];
  randomIn: bigint[];
  valueIn: bigint[];
  pathElements: bigint[][];
  leavesIndices: bigint[];
  nullifyingKey: bigint;
  npkOut: bigint[];
  valueOut: bigint[];
};

export type RailgunTransactionRequestV2 = {
  txidVersion: TXIDVersion.V2_PoseidonMerkle;
  privateInputs: PrivateInputsRailgun;
  publicInputs: PublicInputsRailgun;
  boundParams: BoundParamsStruct;
};

export type RailgunTransactionRequestV3 = {
  txidVersion: TXIDVersion.V3_PoseidonMerkle;
  privateInputs: PrivateInputsRailgun;
  publicInputs: PublicInputsRailgun;
  boundParams: PoseidonMerkleVerifier.BoundParamsStruct;
};

export type RailgunTransactionRequest = RailgunTransactionRequestV2 | RailgunTransactionRequestV3;

export type UnprovedTransactionInputs = RailgunTransactionRequest & {
  signature: [bigint, bigint, bigint];
};

export type FormattedCircuitInputsRailgun = {
  merkleRoot: bigint;
  boundParamsHash: bigint;
  nullifiers: bigint[];
  commitmentsOut: bigint[];
  token: bigint;
  publicKey: bigint[];
  signature: bigint[];
  randomIn: bigint[];
  valueIn: bigint[];
  pathElements: bigint[];
  leavesIndices: bigint[];
  nullifyingKey: bigint;
  npkOut: bigint[];
  valueOut: bigint[];
};

export type NativeProverFormattedJsonInputsRailgun = {
  merkleRoot: string;
  boundParamsHash: string;
  nullifiers: string[];
  commitmentsOut: string[];
  token: string;
  publicKey: string[];
  signature: string[];
  randomIn: string[];
  valueIn: string[];
  pathElements: string[];
  leavesIndices: string[];
  nullifyingKey: string;
  npkOut: string[];
  valueOut: string[];
};

// DIVERGES FROM UPSTREAM: proof-of-innocence prover input types removed (SPEC §3.5).

export type ArtifactGetter = {
  assertArtifactExists: (nullifiers: number, commitments: number) => void;
  getArtifacts: (publicInputs: PublicInputsRailgun) => Promise<Artifact>;
};
