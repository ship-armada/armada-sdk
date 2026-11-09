// ABOUTME: Disclosure package checker (ADR-0020) — verifies both EIP-712 signatures, every disclosure
// ABOUTME: proof and every hop (H1–H6) against chain events, returning the first failing check by name.

import { AbiCoder, keccak256, getAddress } from 'ethers';
import { ShieldNote, getTokenDataHash } from '../core/index';
import type { ProverAdapter } from '../prover/index';
import { hashHops, statementHashField, verifyEndpointSignature } from './statement';
import type { DisclosureChainSource, EventScope, HubFinalizedOutcomeRecord } from './chain-source';
import { getChannelId, hashNitroState, recoverNitroSigner, participantDestination } from './nitro';
import {
  DISCLOSURE_PACKAGE_VERSION,
  SHIELD_ALLOCATION_TYPE,
  type ChannelStatesEntry,
  type CommitmentLocation,
  type DisclosurePackage,
  type DisclosureProofEntry,
  type Hop,
  type Hop7,
  type NoteOpening,
  type SignedChannelState,
} from './types';

/** The name of each check the verifier runs; a failure reports exactly one of these. */
export type DisclosureCheckName =
  | 'package-version'
  | 'statement-hops-hash'
  | 'endpoint-signature'
  | 'hop-reference'
  | 'opening-master-public-key'
  | 'opening-npk'
  | 'shield-commitment'
  | 'shield-sender'
  | 'transact-commitment'
  | 'proof-statement-hash'
  | 'proof-master-public-key'
  | 'proof-verification'
  | 'spend-leaf-position'
  | 'nullifier-event'
  | 'deposit-binding'
  | 'deposited-event'
  | 'finalized-shield-allocation'
  | 'unshield-event'
  | 'event-chain-mismatch'
  | 'event-contract-mismatch'
  | 'missing-adjudicator'
  | 'attribution-claim'
  | 'attribution-participant'
  | 'channel-states'
  | 'channel-id'
  | 'state-signatures'
  | 'state-turn-order'
  | 'attribution-first-state'
  | 'attribution-finalized'
  | 'unexpected-channel-states'
  | 'missing-attribution-hop';

export interface DisclosureCheckFailure {
  readonly check: DisclosureCheckName;
  /** The index of the hop that failed, or undefined for a package-wide check. */
  readonly hop?: number;
  readonly detail: string;
}

/** One change to a user's channel allocation that an attribution reports. */
export interface AllocationChange {
  readonly channelId: string;
  /** The turn number of the state after the change. */
  readonly turnNum: number;
  readonly asset: string;
  /** The user's allocation amount before and after, decimal strings. */
  readonly before: string;
  readonly after: string;
}

/** What a verifier learns from a package that passes every check. */
export interface DisclosureLearned {
  readonly masterPublicKey: string;
  readonly endpoints: readonly { role: string; account: string }[];
  readonly transactionIds: readonly string[];
  readonly channelIds: readonly string[];
  /** The user's allocation changes per attributed channel (D20.5). Empty when nothing is claimed. */
  readonly attributions: readonly AllocationChange[];
}

export interface DisclosureCheckResult {
  readonly ok: boolean;
  readonly failure?: DisclosureCheckFailure;
  readonly learned?: DisclosureLearned;
}

export interface CheckDisclosureParams {
  readonly package: DisclosurePackage;
  readonly source: DisclosureChainSource;
  readonly prover: ProverAdapter;
  /** The disclosure circuit's verifying key (`ArtifactSet.vkey`). */
  readonly vkey: object;
}
function failure(check: DisclosureCheckName, detail: string, hop?: number): DisclosureCheckResult {
  return { ok: false, failure: hop === undefined ? { check, detail } : { check, detail, hop } };
}

/** Recompute the commitment hash Poseidon(npk, tokenHash, value) for an opened note. */
function commitmentHash(opening: NoteOpening): bigint {
  return ShieldNote.getShieldNoteHash(BigInt(opening.npk), getTokenDataHash(opening.token), BigInt(opening.value));
}

/**
 * Verify every EIP-712 signature, every referenced disclosure proof and every hop. Returns on the
 * first failing check, naming the check and the hop it belongs to.
 */
export async function checkDisclosurePackage(params: CheckDisclosureParams): Promise<DisclosureCheckResult> {
  const pkg = params.package;

  if (pkg.version !== DISCLOSURE_PACKAGE_VERSION) {
    return failure('package-version', `unsupported package version ${String(pkg.version)}`);
  }

  // Package-wide: the signed hop hash must match the actual hop list, and every named endpoint must
  // carry a valid signature over the statement.
  if (hashHops(pkg.hops) !== pkg.statement.hopsHash) {
    return failure('statement-hops-hash', 'hopsHash does not match the hop list');
  }

  const statementHash = statementHashField(pkg.domain, pkg.statement).toString();

  for (const endpoint of pkg.statement.endpoints) {
    const sig = pkg.endpointSignatures.find((s) => s.role === endpoint.role && s.account === endpoint.account);
    if (sig === undefined) {
      return failure('endpoint-signature', `no signature for endpoint role "${endpoint.role}"`);
    }
    if (!verifyEndpointSignature(pkg.domain, pkg.statement, endpoint.account, sig.signature)) {
      return failure('endpoint-signature', `signature for endpoint role "${endpoint.role}" does not recover to ${endpoint.account}`);
    }
  }

  const openingByLabel = new Map(pkg.openings.map((o) => [o.label, o]));
  const proofById = new Map(pkg.proofs.map((p) => [p.id, p]));
  const endpointByRole = new Map(pkg.statement.endpoints.map((e) => [e.role, e]));
  const verifiedProofs = new Set<string>();

  // Chain scope (ADR-0020 D20.6). The statement names one chain (the domain), one pool (the domain's
  // verifyingContract) and one adjudicator; the checker accepts an event only from those.
  const expectedChainId = pkg.domain.chainId;
  const poolContract = pkg.domain.verifyingContract;
  const adjudicator = pkg.statement.adjudicator;

  // Attribution (ADR-0020 D20.5). Without a claim the package carries no channel states and no H7 hop.
  const channelStatesById = new Map((pkg.channelStates ?? []).map((c) => [c.channelId.toLowerCase(), c]));
  const attributedChannels = new Set<string>();
  const attributionChanges: AllocationChange[] = [];
  if (pkg.statement.attributions.length === 0 && ((pkg.channelStates?.length ?? 0) > 0 || pkg.hops.some((h) => h.kind === 'H7'))) {
    return failure('unexpected-channel-states', 'statement claims no attribution but the package carries channel states');
  }

  // True when an event's scope is the statement's chain and the given contract.
  const inScope = (scope: EventScope, contract: string): boolean =>
    scope.chainId === expectedChainId && addressesEqual(scope.contract, contract);

  // Report the first way a scope differs from the statement's chain and the expected contract.
  const scopeFailure = (scope: EventScope, contract: string, hopIndex: number): DisclosureCheckResult => {
    if (scope.chainId !== expectedChainId) {
      return failure('event-chain-mismatch', `event chain ${scope.chainId} is not the statement's chain ${expectedChainId}`, hopIndex);
    }
    return failure('event-contract-mismatch', `event contract ${scope.contract} is not ${contract}`, hopIndex);
  };

  // A channel hop (H4, H5, H7) requires the statement to name a non-zero adjudicator.
  const requireAdjudicator = (hopIndex: number): DisclosureCheckResult | null =>
    BigInt(adjudicator) === 0n ? failure('missing-adjudicator', 'statement names no adjudicator for a channel hop', hopIndex) : null;

  // Verify one proof: its public statement hash and masterPublicKey must match the statement, and the
  // Groth16 proof must verify against the disclosure vkey. Cached so a shared proof verifies once.
  const verifyProof = async (entry: DisclosureProofEntry, hopIndex: number): Promise<DisclosureCheckResult | null> => {
    if (verifiedProofs.has(entry.id)) {
      return null;
    }
    if (entry.statementHash !== statementHash) {
      return failure('proof-statement-hash', `proof "${entry.id}" statementHash is not the statement's`, hopIndex);
    }
    if (entry.masterPublicKey !== pkg.statement.masterPublicKey) {
      return failure('proof-master-public-key', `proof "${entry.id}" masterPublicKey is not the statement's`, hopIndex);
    }
    const signals = [
      BigInt(entry.statementHash),
      BigInt(entry.masterPublicKey),
      BigInt(entry.nullifier),
      BigInt(entry.treeNumber),
      BigInt(entry.leafIndex),
    ];
    const ok = await params.prover.verify(entry.proof, signals, params.vkey);
    if (!ok) {
      return failure('proof-verification', `proof "${entry.id}" does not verify`, hopIndex);
    }
    verifiedProofs.add(entry.id);
    return null;
  };

  // Resolve a referenced opening/proof/endpoint, or report a hop-reference failure.
  const requireOpening = (label: string, hopIndex: number): NoteOpening | DisclosureCheckResult => {
    const opening = openingByLabel.get(label);
    return opening ?? failure('hop-reference', `hop references unknown opening "${label}"`, hopIndex);
  };

  // Check an opened note: its masterPublicKey is the statement's, and npk == Poseidon(M, random).
  const checkOpening = (opening: NoteOpening, hopIndex: number): DisclosureCheckResult | null => {
    if (opening.masterPublicKey !== pkg.statement.masterPublicKey) {
      return failure('opening-master-public-key', `opening "${opening.label}" is not for the statement's masterPublicKey`, hopIndex);
    }
    const npk = ShieldNote.getNotePublicKey(BigInt(opening.masterPublicKey), opening.random);
    if (npk !== BigInt(opening.npk)) {
      return failure('opening-npk', `opening "${opening.label}" npk != Poseidon(M, random)`, hopIndex);
    }
    return null;
  };

  // Check that a shield commitment at `loc` matches the opened note.
  const checkShieldLocation = (opening: NoteOpening, loc: CommitmentLocation, hopIndex: number): DisclosureCheckResult | null => {
    if (opening.tree !== loc.tree || opening.position !== loc.position) {
      return failure('shield-commitment', `opening "${opening.label}" position does not match hop shield location`, hopIndex);
    }
    const candidates = params.source
      .shieldsIn(loc.txid)
      .filter((s) => s.tree === loc.tree && s.position === loc.position);
    if (candidates.length === 0) {
      return failure('shield-commitment', `no Shield commitment at (${loc.txid}, tree ${loc.tree}, position ${loc.position})`, hopIndex);
    }
    const record = candidates.find((s) => inScope(s, poolContract));
    if (record === undefined) {
      return scopeFailure(candidates[0]!, poolContract, hopIndex);
    }
    if (BigInt(`0x${record.hash}`) !== commitmentHash(opening)) {
      return failure('shield-commitment', `Shield commitment at (${loc.txid}) does not match the opened note`, hopIndex);
    }
    return null;
  };

  const transactionIds = new Set<string>();
  const channelIds = new Set<string>();

  for (let i = 0; i < pkg.hops.length; i++) {
    const hop = pkg.hops[i]!;
    const result = await checkHop(hop, i);
    if (result !== null) {
      return result;
    }
  }

  // Verify one hop; returns a failure result, or null when the hop passes.
  async function checkHop(hop: Hop, i: number): Promise<DisclosureCheckResult | null> {
    switch (hop.kind) {
      case 'H1': {
        const opening = requireOpening(hop.note, i);
        if ('ok' in opening) return opening;
        const endpoint = endpointByRole.get(hop.endpoint);
        if (endpoint === undefined) return failure('hop-reference', `H1 references unknown endpoint "${hop.endpoint}"`, i);
        const openErr = checkOpening(opening, i);
        if (openErr !== null) return openErr;
        const shieldErr = checkShieldLocation(opening, hop.shield, i);
        if (shieldErr !== null) return shieldErr;
        const sender = params.source.senderOf(hop.shield.txid);
        if (sender !== undefined && !addressesEqual(sender, endpoint.account)) {
          return failure('shield-sender', `Shield tx sender ${sender} is not endpoint ${endpoint.account}`, i);
        }
        transactionIds.add(hop.shield.txid);
        return null;
      }
      case 'H2': {
        const opening = requireOpening(hop.spends, i);
        if ('ok' in opening) return opening;
        const proof = proofById.get(hop.proof);
        if (proof === undefined) return failure('hop-reference', `H2 references unknown proof "${hop.proof}"`, i);
        const proofErr = await verifyProof(proof, i);
        if (proofErr !== null) return proofErr;
        const posErr = checkSpendLeaf(proof, opening, i);
        if (posErr !== null) return posErr;
        const nullErr = checkNullifierEvent(proof, hop.nullifiedTxid, i);
        if (nullErr !== null) return nullErr;
        transactionIds.add(hop.nullifiedTxid);
        return null;
      }
      case 'H3': {
        const opening = requireOpening(hop.note, i);
        if ('ok' in opening) return opening;
        const openErr = checkOpening(opening, i);
        if (openErr !== null) return openErr;
        if (opening.tree !== hop.transact.tree || opening.position !== hop.transact.position) {
          return failure('transact-commitment', `opening "${opening.label}" position does not match hop transact location`, i);
        }
        const transactCandidates = params.source
          .transactsIn(hop.transact.txid)
          .filter((t) => t.tree === hop.transact.tree && t.position === hop.transact.position);
        if (transactCandidates.length === 0) {
          return failure('transact-commitment', `no Transact commitment at (${hop.transact.txid}, tree ${hop.transact.tree}, position ${hop.transact.position})`, i);
        }
        const record = transactCandidates.find((t) => inScope(t, poolContract));
        if (record === undefined) {
          return scopeFailure(transactCandidates[0]!, poolContract, i);
        }
        if (BigInt(`0x${record.hash}`) !== commitmentHash(opening)) {
          return failure('transact-commitment', `Transact commitment at (${hop.transact.txid}) does not match the opened note`, i);
        }
        transactionIds.add(hop.transact.txid);
        return null;
      }
      case 'H4': {
        const proof = proofById.get(hop.proof);
        if (proof === undefined) return failure('hop-reference', `H4 references unknown proof "${hop.proof}"`, i);
        const proofErr = await verifyProof(proof, i);
        if (proofErr !== null) return proofErr;
        // The funding spend must publish its nullifier in the deposit transaction. Without this check a
        // prover pairs a proof for any of their own notes with another wallet's real Deposited event.
        const nullErr = checkNullifierEvent(proof, hop.depositTxid, i);
        if (nullErr !== null) return nullErr;
        const adjErr = requireAdjudicator(i);
        if (adjErr !== null) return adjErr;
        const depositCandidates = params.source
          .depositsIn(hop.depositTxid)
          .filter((d) => addressesEqual(d.channelId, hop.channelId));
        if (depositCandidates.length === 0) {
          return failure('deposited-event', `no Deposited event for channel ${hop.channelId} in ${hop.depositTxid}`, i);
        }
        const deposit = depositCandidates.find((d) => inScope(d, adjudicator));
        if (deposit === undefined) {
          return scopeFailure(depositCandidates[0]!, adjudicator, i);
        }
        const binding = keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [hop.channelId, BigInt(hop.expectedHeld)]));
        if (BigInt(deposit.adaptParams) !== BigInt(binding)) {
          return failure('deposit-binding', `deposit adaptParams != depositBinding(channelId, expectedHeld) in ${hop.depositTxid}`, i);
        }
        if (!addressesEqual(deposit.asset, hop.asset)) {
          return failure('deposited-event', `Deposited asset ${deposit.asset} != ${hop.asset} in ${hop.depositTxid}`, i);
        }
        transactionIds.add(hop.depositTxid);
        channelIds.add(hop.channelId);
        return null;
      }
      case 'H5': {
        const opening = requireOpening(hop.note, i);
        if ('ok' in opening) return opening;
        const openErr = checkOpening(opening, i);
        if (openErr !== null) return openErr;
        const adjErr = requireAdjudicator(i);
        if (adjErr !== null) return adjErr;
        const outcomeCandidates = params.source
          .finalizedOutcomesIn(hop.concludeTxid)
          .filter((o) => addressesEqual(o.channelId, hop.channelId));
        if (outcomeCandidates.length === 0) {
          return failure('finalized-shield-allocation', `channel ${hop.channelId} has no finalized outcome in ${hop.concludeTxid}`, i);
        }
        const outcome = outcomeCandidates.find((o) => inScope(o, adjudicator));
        if (outcome === undefined) {
          return scopeFailure(outcomeCandidates[0]!, adjudicator, i);
        }
        const paysNote = outcome.allocations.some(
          (a) => a.allocationType === SHIELD_ALLOCATION_TYPE && BigInt(a.destination) === BigInt(opening.npk),
        );
        if (paysNote !== true) {
          return failure('finalized-shield-allocation', `channel ${hop.channelId} has no SHIELD allocation to note "${opening.label}" in ${hop.concludeTxid}`, i);
        }
        const shieldErr = checkShieldLocation(opening, hop.shield, i);
        if (shieldErr !== null) return shieldErr;
        transactionIds.add(hop.concludeTxid);
        transactionIds.add(hop.shield.txid);
        channelIds.add(hop.channelId);
        return null;
      }
      case 'H6': {
        const opening = requireOpening(hop.spends, i);
        if ('ok' in opening) return opening;
        const proof = proofById.get(hop.proof);
        if (proof === undefined) return failure('hop-reference', `H6 references unknown proof "${hop.proof}"`, i);
        const endpoint = endpointByRole.get(hop.endpoint);
        if (endpoint === undefined) return failure('hop-reference', `H6 references unknown endpoint "${hop.endpoint}"`, i);
        const proofErr = await verifyProof(proof, i);
        if (proofErr !== null) return proofErr;
        const posErr = checkSpendLeaf(proof, opening, i);
        if (posErr !== null) return posErr;
        const nullErr = checkNullifierEvent(proof, hop.unshieldTxid, i);
        if (nullErr !== null) return nullErr;
        const unshieldCandidates = params.source
          .unshieldsIn(hop.unshieldTxid)
          .filter((u) => addressesEqual(u.to, endpoint.account));
        if (unshieldCandidates.length === 0) {
          return failure('unshield-event', `no Unshield to ${endpoint.account} in ${hop.unshieldTxid}`, i);
        }
        const unshield = unshieldCandidates.find((u) => inScope(u, poolContract));
        if (unshield === undefined) {
          return scopeFailure(unshieldCandidates[0]!, poolContract, i);
        }
        transactionIds.add(hop.unshieldTxid);
        return null;
      }
      case 'H7': {
        const adjErr = requireAdjudicator(i);
        if (adjErr !== null) return adjErr;
        const claim = pkg.statement.attributions.find((a) => addressesEqual(a.channelId, hop.channelId));
        if (claim === undefined) {
          return failure('attribution-claim', `no attribution claim for channel ${hop.channelId}`, i);
        }
        if (!addressesEqual(claim.participant, hop.participant)) {
          return failure('attribution-claim', `H7 participant ${hop.participant} is not the claim participant`, i);
        }
        const endpoint = pkg.statement.endpoints.find((e) => addressesEqual(e.account, hop.participant));
        if (endpoint === undefined) {
          return failure('attribution-participant', `participant ${hop.participant} is not a signed endpoint`, i);
        }
        const entry = channelStatesById.get(hop.channelId.toLowerCase());
        if (entry === undefined) {
          return failure('channel-states', `no channel states for channel ${hop.channelId}`, i);
        }
        const statesErr = await checkChannelStates(hop, entry, i);
        if (statesErr !== null) return statesErr;
        attributedChannels.add(hop.channelId.toLowerCase());
        channelIds.add(hop.channelId);
        transactionIds.add(hop.depositTxid);
        transactionIds.add(hop.concludeTxid);
        return null;
      }
    }
  }

  // A disclosure proof binds a nullifier at (treeNumber, leafIndex); the spent note's opening must sit
  // at exactly that leaf.
  function checkSpendLeaf(proof: DisclosureProofEntry, opening: NoteOpening, hopIndex: number): DisclosureCheckResult | null {
    if (proof.treeNumber !== opening.tree || proof.leafIndex !== opening.position) {
      return failure('spend-leaf-position', `proof "${proof.id}" leaf (${proof.treeNumber}, ${proof.leafIndex}) != opening "${opening.label}" (${opening.tree}, ${opening.position})`, hopIndex);
    }
    return null;
  }

  // The proof's nullifier must appear in the named transaction's Nullified event, in the proof's tree.
  function checkNullifierEvent(proof: DisclosureProofEntry, txid: string, hopIndex: number): DisclosureCheckResult | null {
    const candidates = params.source
      .nullifiersIn(txid)
      .filter((n) => n.tree === proof.treeNumber && n.nullifier === BigInt(proof.nullifier));
    if (candidates.length === 0) {
      return failure('nullifier-event', `nullifier of proof "${proof.id}" not in Nullified event of ${txid}`, hopIndex);
    }
    const record = candidates.find((n) => inScope(n, poolContract));
    if (record === undefined) {
      return scopeFailure(candidates[0]!, poolContract, hopIndex);
    }
    return null;
  }

  // The user's allocation amount for `asset` in one state, or undefined when the state has none.
  function userAllocationAmount(state: SignedChannelState, asset: string, userDest: string): bigint | undefined {
    const exit = state.outcome.find((e) => addressesEqual(e.asset, asset));
    const alloc = exit?.allocations.find((a) => addressesEqual(a.destination, userDest));
    return alloc === undefined ? undefined : BigInt(alloc.amount);
  }

  // The last state's outcome for the finalized asset must equal the on-chain finalized allocations.
  function lastStateMatchesOutcome(last: SignedChannelState, outcome: HubFinalizedOutcomeRecord): boolean {
    const exit = last.outcome.find((e) => addressesEqual(e.asset, outcome.asset));
    if (exit === undefined || exit.allocations.length !== outcome.allocations.length) return false;
    return exit.allocations.every((a, k) => {
      const b = outcome.allocations[k]!;
      return addressesEqual(a.destination, b.destination) && BigInt(a.amount) === BigInt(b.amount) && a.allocationType === b.allocationType;
    });
  }

  // Record each change to the user's allocation across the channel's states, per asset.
  function recordAllocationChanges(channelId: string, entry: ChannelStatesEntry, userDest: string): void {
    const assets = new Set(entry.states.flatMap((st) => st.outcome.map((e) => e.asset)));
    for (const asset of assets) {
      let prev: bigint | undefined;
      for (const st of entry.states) {
        const amt = userAllocationAmount(st, asset, userDest);
        if (prev !== undefined && amt !== undefined && amt !== prev) {
          attributionChanges.push({ channelId, turnNum: st.turnNum, asset, before: prev.toString(), after: amt.toString() });
        }
        if (amt !== undefined) prev = amt;
      }
    }
  }

  // The five H7 checks (ADR-0020, engineering/16): the fixed part gives the channel id; every state is
  // signed by all participants; the turn numbers increase; the first state allocates the deposit to the
  // user; the last state's outcome equals the finalized outcome.
  async function checkChannelStates(hop: Hop7, entry: ChannelStatesEntry, i: number): Promise<DisclosureCheckResult | null> {
    const derivedId = getChannelId(entry.fixedPart);
    if (!addressesEqual(derivedId, hop.channelId)) {
      return failure('channel-id', `channel states fixedPart id ${derivedId} != hop channel ${hop.channelId}`, i);
    }
    const participants = entry.fixedPart.participants;
    const partIdx = participants.findIndex((p) => addressesEqual(p, hop.participant));
    if (partIdx < 0) {
      return failure('channel-states', `participant ${hop.participant} is not in channel ${hop.channelId}`, i);
    }
    if (entry.states.length === 0) {
      return failure('channel-states', `channel ${hop.channelId} has no states`, i);
    }
    let prevTurn = -1;
    for (const st of entry.states) {
      if (st.sigs.length !== participants.length) {
        return failure('state-signatures', `state turn ${st.turnNum} is missing a participant signature`, i);
      }
      if (st.turnNum <= prevTurn) {
        return failure('state-turn-order', `state turn ${st.turnNum} does not increase`, i);
      }
      prevTurn = st.turnNum;
      const stateHash = hashNitroState(derivedId, { outcome: st.outcome, appData: st.appData, turnNum: st.turnNum, isFinal: st.isFinal });
      for (let p = 0; p < participants.length; p++) {
        const sig = st.sigs[p]!;
        if (p === partIdx) {
          if (!addressesEqual(recoverNitroSigner(stateHash, sig), participants[p]!)) {
            return failure('state-signatures', `user signature invalid at turn ${st.turnNum}`, i);
          }
        } else {
          const ok = await params.source.hubSignatureValid({ chainId: expectedChainId, custodian: participants[p]!, stateHash, signature: sig, blockNumber: hop.hubActiveBlock });
          if (!ok) {
            return failure('state-signatures', `hub signature invalid at turn ${st.turnNum}`, i);
          }
        }
      }
    }
    const deposit = params.source.depositsIn(hop.depositTxid).find((d) => addressesEqual(d.channelId, hop.channelId) && inScope(d, adjudicator));
    if (deposit === undefined) {
      return failure('attribution-first-state', `no in-scope deposit for channel ${hop.channelId} in ${hop.depositTxid}`, i);
    }
    const userDest = participantDestination(hop.participant);
    const firstAmt = userAllocationAmount(entry.states[0]!, hop.asset, userDest);
    if (firstAmt === undefined || firstAmt !== BigInt(deposit.held)) {
      return failure('attribution-first-state', `first state does not allocate the deposit amount ${deposit.held} to the user`, i);
    }
    const outcome = params.source.finalizedOutcomesIn(hop.concludeTxid).find((o) => addressesEqual(o.channelId, hop.channelId) && inScope(o, adjudicator));
    if (outcome === undefined) {
      return failure('attribution-finalized', `no in-scope finalized outcome for channel ${hop.channelId} in ${hop.concludeTxid}`, i);
    }
    if (!lastStateMatchesOutcome(entry.states[entry.states.length - 1]!, outcome)) {
      return failure('attribution-finalized', `last state outcome does not equal the finalized outcome of channel ${hop.channelId}`, i);
    }
    recordAllocationChanges(hop.channelId, entry, userDest);
    return null;
  }

  // Every claimed attribution must be backed by an H7 hop that the loop verified.
  for (const a of pkg.statement.attributions) {
    if (!attributedChannels.has(a.channelId.toLowerCase())) {
      return failure('missing-attribution-hop', `attribution for channel ${a.channelId} has no H7 hop`);
    }
  }

  return {
    ok: true,
    learned: {
      masterPublicKey: pkg.statement.masterPublicKey,
      endpoints: pkg.statement.endpoints.map((e) => ({ role: e.role, account: e.account })),
      transactionIds: [...transactionIds],
      channelIds: [...channelIds],
      attributions: attributionChanges,
    },
  };
}

/** Compare two hex strings (addresses or bytes32) by value, tolerant of 0x case and padding. */
function addressesEqual(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return BigInt(a) === BigInt(b);
  }
}
