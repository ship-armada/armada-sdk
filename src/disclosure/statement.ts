// ABOUTME: Disclosure statement crypto (ADR-0020) — the EIP-712 domain + Statement schema, the canonical
// ABOUTME: hop hash, the `statementHash` (BN254 field) derivation, and EOA signature verification.

import {
  TypedDataEncoder,
  verifyTypedData,
  getAddress,
  keccak256,
  toUtf8Bytes,
  type TypedDataDomain,
  type TypedDataField,
} from 'ethers';
import { SNARK_SCALAR_FIELD } from './types';
import type { DisclosureDomain, DisclosureStatement, Hop } from './types';

export const DISCLOSURE_EIP712_DOMAIN_NAME = 'ArmadaSelectiveDisclosure';
export const DISCLOSURE_EIP712_DOMAIN_VERSION = '1';

/**
 * The EIP-712 type set for a disclosure statement. The signed message commits to M, the audit
 * recipient, the purpose, the issue time, the endpoints and a hash of the hop list. The hop list
 * itself is bound through `hopsHash`, so a signature covers the exact claim it was made for.
 */
export const DISCLOSURE_EIP712_TYPES: Record<string, TypedDataField[]> = {
  Statement: [
    { name: 'masterPublicKey', type: 'uint256' },
    { name: 'verifier', type: 'string' },
    { name: 'context', type: 'string' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'endpoints', type: 'Endpoint[]' },
    { name: 'adjudicator', type: 'address' },
    { name: 'attributions', type: 'Attribution[]' },
    { name: 'hopsHash', type: 'bytes32' },
  ],
  Endpoint: [
    { name: 'role', type: 'string' },
    { name: 'account', type: 'address' },
  ],
  Attribution: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'participant', type: 'address' },
  ],
};

/** Build the full EIP-712 domain object from the pool-scoped `DisclosureDomain`. */
export function eip712Domain(domain: DisclosureDomain): TypedDataDomain {
  return {
    name: DISCLOSURE_EIP712_DOMAIN_NAME,
    version: DISCLOSURE_EIP712_DOMAIN_VERSION,
    chainId: domain.chainId,
    verifyingContract: domain.verifyingContract,
  };
}

/** The EIP-712 message value for a statement (ethers accepts the string/number fields as-is). */
export function statementMessage(statement: DisclosureStatement): Record<string, unknown> {
  return {
    masterPublicKey: statement.masterPublicKey,
    verifier: statement.verifier,
    context: statement.context,
    issuedAt: statement.issuedAt,
    endpoints: statement.endpoints.map((e) => ({ role: e.role, account: e.account })),
    adjudicator: statement.adjudicator,
    attributions: statement.attributions.map((a) => ({ channelId: a.channelId, participant: a.participant })),
    hopsHash: statement.hopsHash,
  };
}

/**
 * Canonical JSON of a value with object keys sorted at every depth. Two packages with the same hops
 * in the same order produce the same bytes, so `hopsHash` is reproducible by any verifier.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** `keccak256` of the canonical hop list — the `hopsHash` the statement binds. */
export function hashHops(hops: readonly Hop[]): string {
  return keccak256(toUtf8Bytes(canonicalJson(hops)));
}

/**
 * The EIP-712 hash of a statement (the 32-byte digest an EOA signs). This is the full-width binding
 * that the EOA signatures cover.
 */
export function statementDigest(domain: DisclosureDomain, statement: DisclosureStatement): string {
  return TypedDataEncoder.hash(eip712Domain(domain), DISCLOSURE_EIP712_TYPES, statementMessage(statement));
}

/**
 * The `statementHash` S that the disclosure circuit consumes: the EIP-712 digest reduced into the
 * BN254 scalar field. The EOA signs the full 256-bit digest; the spending key signs this field
 * element inside the proof. Both cover the same statement; the reduction keeps ~128-bit binding.
 */
export function statementHashField(domain: DisclosureDomain, statement: DisclosureStatement): bigint {
  return BigInt(statementDigest(domain, statement)) % SNARK_SCALAR_FIELD;
}

/** True when `signature` recovers to `account` for the statement under `domain`. */
export function verifyEndpointSignature(
  domain: DisclosureDomain,
  statement: DisclosureStatement,
  account: string,
  signature: string,
): boolean {
  let recovered: string;
  try {
    recovered = verifyTypedData(
      eip712Domain(domain),
      DISCLOSURE_EIP712_TYPES,
      statementMessage(statement),
      signature,
    );
  } catch {
    return false;
  }
  try {
    return getAddress(recovered) === getAddress(account);
  } catch {
    return false;
  }
}
