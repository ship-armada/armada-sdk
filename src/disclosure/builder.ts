// ABOUTME: Disclosure package builder (ADR-0020) — from the wallet keys and its own note data, produces
// ABOUTME: the openings, the Groth16 disclosure proofs for chosen nullifiers, and the statement to sign.

import { ZeroAddress } from 'ethers';
import type { TypedDataDomain, TypedDataField } from 'ethers';
import { ShieldNote, type TokenData } from '../core/index';
import type { ArtifactSet, ProverAdapter } from '../prover/index';
import { InvalidRequestError } from '../errors';
import {
  DISCLOSURE_EIP712_TYPES,
  eip712Domain,
  hashHops,
  statementHashField,
  statementMessage,
} from './statement';
import { disclosurePublicSignals, formatDisclosureInput, type DisclosureSigningKeys } from './circuit';
import {
  DISCLOSURE_PACKAGE_VERSION,
  type AttributionClaim,
  type ChannelStatesEntry,
  type DisclosureDomain,
  type DisclosurePackage,
  type DisclosureProofEntry,
  type DisclosureStatement,
  type EndpointSignature,
  type Hop,
  type NoteOpening,
} from './types';

/** A note the wallet owns and chooses to open — its random, token, value and leaf location. */
export interface BuilderOpening {
  readonly label: string;
  /** The 16-byte note random, 0x-prefixed hex. */
  readonly random: string;
  readonly token: TokenData;
  readonly value: bigint;
  readonly tree: number;
  readonly position: number;
}

/** A spend to prove: the disclosure-proof id and the opening label of the spent note. */
export interface BuilderSpend {
  readonly id: string;
  readonly opening: string;
}

/** The EIP-712 payload an endpoint signer receives; it returns the 0x signature by `account`. */
export interface EndpointSignRequest {
  readonly account: string;
  readonly domain: TypedDataDomain;
  readonly types: Record<string, TypedDataField[]>;
  readonly message: Record<string, unknown>;
}

export type EndpointSigner = (request: EndpointSignRequest) => Promise<string>;

export interface BuildDisclosureParams {
  readonly keyset: DisclosureSigningKeys;
  readonly domain: DisclosureDomain;
  readonly verifier: string;
  readonly context: string;
  /** Unix seconds; defaults to `Math.floor(Date.now() / 1000)`. */
  readonly issuedAt?: number;
  readonly endpoints: readonly { role: string; account: string }[];
  /** The armada-nitro adjudicator address, required when the hops include H4, H5 or H7 (D20.6). */
  readonly adjudicator?: string;
  /** The attribution claims (D20.5); when set, `channelStates` must carry the co-signed states. */
  readonly attributions?: readonly AttributionClaim[];
  /** The co-signed channel states that H7 verifies; present only with an attribution claim. */
  readonly channelStates?: readonly ChannelStatesEntry[];
  readonly openings: readonly BuilderOpening[];
  readonly spends: readonly BuilderSpend[];
  readonly hops: readonly Hop[];
  readonly prover: ProverAdapter;
  readonly artifacts: ArtifactSet;
  /** Produces one EIP-712 signature per endpoint EOA over the statement. */
  readonly signEndpoint: EndpointSigner;
}

/**
 * Build a complete disclosure package. The order is load-bearing: the statement (and its field hash)
 * must exist before any proof, because every proof's signed message commits to `statementHash`.
 */
export async function buildDisclosurePackage(params: BuildDisclosureParams): Promise<DisclosurePackage> {
  const masterPublicKeyDec = params.keyset.masterPublicKey.toString();

  const openings: NoteOpening[] = params.openings.map((o) => {
    const npk = ShieldNote.getNotePublicKey(params.keyset.masterPublicKey, o.random);
    return {
      label: o.label,
      masterPublicKey: masterPublicKeyDec,
      random: o.random,
      npk: `0x${npk.toString(16)}`,
      token: o.token,
      value: o.value.toString(),
      tree: o.tree,
      position: o.position,
    };
  });
  const openingByLabel = new Map(openings.map((o) => [o.label, o]));

  const issuedAt = params.issuedAt ?? Math.floor(Date.now() / 1000);
  const statement: DisclosureStatement = {
    masterPublicKey: masterPublicKeyDec,
    verifier: params.verifier,
    context: params.context,
    issuedAt,
    endpoints: params.endpoints.map((e) => ({ role: e.role, account: e.account })),
    adjudicator: params.adjudicator ?? ZeroAddress,
    attributions: (params.attributions ?? []).map((a) => ({ channelId: a.channelId, participant: a.participant })),
    hopsHash: hashHops(params.hops),
  };

  const statementHash = statementHashField(params.domain, statement);

  const proofs: DisclosureProofEntry[] = [];
  for (const spend of params.spends) {
    const opening = openingByLabel.get(spend.opening);
    if (opening === undefined) {
      throw new InvalidRequestError(`buildDisclosurePackage: spend "${spend.id}" references unknown opening "${spend.opening}"`);
    }
    const input = formatDisclosureInput(params.keyset, statementHash, opening.tree, opening.position);
    const signals = disclosurePublicSignals(input);
    const proof = await params.prover.prove(input, params.artifacts);
    proofs.push({
      id: spend.id,
      statementHash: signals[0]!.toString(),
      masterPublicKey: signals[1]!.toString(),
      nullifier: signals[2]!.toString(),
      treeNumber: Number(signals[3]!),
      leafIndex: Number(signals[4]!),
      proof,
    });
  }

  const fullDomain = eip712Domain(params.domain);
  const message = statementMessage(statement);
  const endpointSignatures: EndpointSignature[] = [];
  for (const endpoint of params.endpoints) {
    const signature = await params.signEndpoint({
      account: endpoint.account,
      domain: fullDomain,
      types: DISCLOSURE_EIP712_TYPES,
      message,
    });
    endpointSignatures.push({ role: endpoint.role, account: endpoint.account, signature });
  }
  // The package is a JSON wire format, so channel-state amounts and the channel nonce are stored as
  // decimal strings (a caller may pass them as bigint for convenience).
  const channelStates = params.channelStates?.map(jsonSafeChannelStates);

  return {
    version: DISCLOSURE_PACKAGE_VERSION,
    domain: params.domain,
    statement,
    endpointSignatures,
    openings,
    proofs,
    hops: params.hops,
    ...(channelStates !== undefined ? { channelStates } : {}),
  };
}

function jsonSafeChannelStates(entry: ChannelStatesEntry): ChannelStatesEntry {
  return {
    channelId: entry.channelId,
    fixedPart: { ...entry.fixedPart, channelNonce: String(entry.fixedPart.channelNonce) },
    states: entry.states.map((s) => ({
      ...s,
      outcome: s.outcome.map((e) => ({
        ...e,
        allocations: e.allocations.map((a) => ({ ...a, amount: String(a.amount) })),
      })),
    })),
  };
}
