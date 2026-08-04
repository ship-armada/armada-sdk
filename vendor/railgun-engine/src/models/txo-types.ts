import { TransactNote } from '../note/transact-note';
import { CommitmentType, OutputType, TokenData } from './formatted-types';

export type TXO = {
  tree: number;
  position: number;
  txid: string;
  timestamp: Optional<number>;
  blockNumber: number;
  spendtxid: string | false;
  nullifier: string;
  note: TransactNote;
  blindedCommitment: Optional<string>;
  commitmentType: CommitmentType;
  transactCreationRailgunTxid: Optional<string>;
};

export type SentCommitment = {
  tree: number;
  position: number;
  txid: string;
  timestamp: Optional<number>;
  note: TransactNote;
  walletSource: Optional<string>;
  outputType: Optional<OutputType>;
  isLegacyTransactNote: boolean;
  railgunTxid: Optional<string>;
  blindedCommitment: Optional<string>;
  commitmentType: CommitmentType;
};

export type SpendingSolutionGroup = {
  utxos: TXO[];
  spendingTree: number;
  tokenOutputs: TransactNote[];
  unshieldValue: bigint;
  tokenData: TokenData;
};

export type UnshieldData = {
  toAddress: string;
  value: bigint;
  tokenData: TokenData;
  allowOverride?: boolean;
};

// DIVERGES FROM UPSTREAM: TXO proof-of-innocence status types removed (SPEC §3.5).

export enum WalletBalanceBucket {
  Spendable = 'Spendable',
  ShieldBlocked = 'ShieldBlocked',
  ShieldPending = 'ShieldPending',
  ProofSubmitted = 'ProofSubmitted',
  Spent = 'Spent', // ie. Unshielded To Origin
}
