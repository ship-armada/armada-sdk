// ABOUTME: The chain-event source the disclosure checker reads (ADR-0020). Pool events reuse the SDK's
// ABOUTME: decoded shapes; every record carries the emitting chain id and contract (D20.6 chain scope).

import type {
  DecodedNullifier,
  DecodedShieldCommitment,
  DecodedTransactCommitment,
  DecodedUnshield,
} from '../sync/event-decoder';

/**
 * The chain and the contract that emitted an event (ADR-0020 D20.6). Every record the checker reads
 * carries this, so the checker can reject an event that comes from a chain or contract the statement
 * does not name. The caller's decoder/sync layer stamps it from the log's chain id and emitting
 * address. One `DisclosureChainSource` need not be single-deployment-scoped once records carry scope.
 */
export interface EventScope {
  readonly chainId: number;
  /** The emitting contract address: the pool for pool events, the adjudicator for hub events. */
  readonly contract: string;
}

/** A pool `Shield` commitment with its emitting chain and contract. */
export type ScopedShieldCommitment = DecodedShieldCommitment & EventScope;
/** A pool `Transact` commitment with its emitting chain and contract. */
export type ScopedTransactCommitment = DecodedTransactCommitment & EventScope;
/** A pool `Nullified` marker with its emitting chain and contract. */
export type ScopedNullifier = DecodedNullifier & EventScope;
/** A pool `Unshield` with its emitting chain and contract. */
export type ScopedUnshield = DecodedUnshield & EventScope;

/** An armada-nitro `Deposited(channelId, asset, held)` event, with the spend's bound `adaptParams`. */
export interface HubDepositRecord extends EventScope {
  readonly txid: string;
  /** The channel id (go-nitro `destination`), 0x-prefixed `bytes32`. */
  readonly channelId: string;
  readonly asset: string;
  /** The deposited holding, decimal string. */
  readonly held: string;
  /** The `adaptParams` committed by the funding spend, 0x-prefixed `bytes32`. */
  readonly adaptParams: string;
}

/** One allocation of a finalized channel outcome. */
export interface HubAllocation {
  /** `bytes32` destination; for a `SHIELD` allocation this is the payout note public key. */
  readonly destination: string;
  /** The allocation amount, decimal string. */
  readonly amount: string;
  /** `ArmadaNitroAdjudicator.SHIELD` == 3 for a shielded payout. */
  readonly allocationType: number;
}

/** A finalized channel outcome for one asset. */
export interface HubFinalizedOutcomeRecord extends EventScope {
  readonly txid: string;
  readonly channelId: string;
  readonly asset: string;
  readonly allocations: readonly HubAllocation[];
}

/**
 * The read interface the checker uses. A verifier adapts its own chain access (RPC logs, an indexer)
 * to these per-transaction lookups. {@link InMemoryDisclosureChainSource} builds one from decoded
 * event arrays for tests and for a caller that already has the events in memory.
 */
export interface DisclosureChainSource {
  shieldsIn(txid: string): readonly ScopedShieldCommitment[];
  transactsIn(txid: string): readonly ScopedTransactCommitment[];
  nullifiersIn(txid: string): readonly ScopedNullifier[];
  unshieldsIn(txid: string): readonly ScopedUnshield[];
  depositsIn(txid: string): readonly HubDepositRecord[];
  finalizedOutcomesIn(txid: string): readonly HubFinalizedOutcomeRecord[];
  /** The sender (`from`) of a transaction, when known; used for the optional H1 sender check. */
  senderOf(txid: string): string | undefined;
  /**
   * Whether `signature` is a valid EIP-1271 signature by the hub custodian `request.custodian` over
   * the go-nitro state hash `request.stateHash`, at `request.blockNumber` (a block where the hub's
   * delegate was active). The verifier implements this with a `staticcall` to `isValidSignature`
   * (ADR-0020 H7, armada-nitro `NitroUtils.isAuthorizedBy`). Returns false when no custodian is set.
   */
  hubSignatureValid(request: HubSignatureRequest): Promise<boolean>;
}

/** A request to verify a hub custodian's EIP-1271 signature over a channel state hash. */
export interface HubSignatureRequest {
  readonly chainId: number;
  /** The hub custodian contract address (a channel participant). */
  readonly custodian: string;
  /** The go-nitro state hash, 0x-prefixed `bytes32`. */
  readonly stateHash: string;
  /** The hub's signature over the EIP-191 prefixed state hash. */
  readonly signature: NitroSignature;
  /** A block where the hub's delegate was active. */
  readonly blockNumber: number;
}

/** A go-nitro ECDSA signature `{v, r, s}`. */
export interface NitroSignature {
  readonly v: number;
  readonly r: string;
  readonly s: string;
}

export interface DisclosureChainData {
  readonly shields?: readonly ScopedShieldCommitment[];
  readonly transacts?: readonly ScopedTransactCommitment[];
  readonly nullifiers?: readonly ScopedNullifier[];
  readonly unshields?: readonly ScopedUnshield[];
  readonly deposits?: readonly HubDepositRecord[];
  readonly finalizedOutcomes?: readonly HubFinalizedOutcomeRecord[];
  /** Optional map of txid → sender address. */
  readonly senders?: Readonly<Record<string, string>>;
  /** Optional hub EIP-1271 verifier (H7). Defaults to rejecting every hub signature. */
  readonly hubSignatureValid?: (request: HubSignatureRequest) => Promise<boolean>;
}

function indexByTxid<T extends { readonly txid: string }>(rows: readonly T[] | undefined): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const row of rows ?? []) {
    const bucket = index.get(row.txid);
    if (bucket === undefined) {
      index.set(row.txid, [row]);
    } else {
      bucket.push(row);
    }
  }
  return index;
}

/** An in-memory chain source built from decoded pool events and hub records. */
export class InMemoryDisclosureChainSource implements DisclosureChainSource {
  private readonly shields: Map<string, ScopedShieldCommitment[]>;
  private readonly transacts: Map<string, ScopedTransactCommitment[]>;
  private readonly nullifiers: Map<string, ScopedNullifier[]>;
  private readonly unshields: Map<string, ScopedUnshield[]>;
  private readonly deposits: Map<string, HubDepositRecord[]>;
  private readonly finalizedOutcomes: Map<string, HubFinalizedOutcomeRecord[]>;
  private readonly senders: Readonly<Record<string, string>>;
  private readonly hubVerifier: ((request: HubSignatureRequest) => Promise<boolean>) | undefined;

  constructor(data: DisclosureChainData) {
    this.shields = indexByTxid(data.shields);
    this.transacts = indexByTxid(data.transacts);
    this.nullifiers = indexByTxid(data.nullifiers);
    this.unshields = indexByTxid(data.unshields);
    this.deposits = indexByTxid(data.deposits);
    this.finalizedOutcomes = indexByTxid(data.finalizedOutcomes);
    this.senders = data.senders ?? {};
    this.hubVerifier = data.hubSignatureValid;
  }

  shieldsIn(txid: string): readonly ScopedShieldCommitment[] {
    return this.shields.get(txid) ?? [];
  }

  transactsIn(txid: string): readonly ScopedTransactCommitment[] {
    return this.transacts.get(txid) ?? [];
  }

  nullifiersIn(txid: string): readonly ScopedNullifier[] {
    return this.nullifiers.get(txid) ?? [];
  }

  unshieldsIn(txid: string): readonly ScopedUnshield[] {
    return this.unshields.get(txid) ?? [];
  }

  depositsIn(txid: string): readonly HubDepositRecord[] {
    return this.deposits.get(txid) ?? [];
  }

  finalizedOutcomesIn(txid: string): readonly HubFinalizedOutcomeRecord[] {
    return this.finalizedOutcomes.get(txid) ?? [];
  }

  senderOf(txid: string): string | undefined {
    return this.senders[txid];
  }

  async hubSignatureValid(request: HubSignatureRequest): Promise<boolean> {
    return this.hubVerifier !== undefined ? this.hubVerifier(request) : false;
  }
}
