// ABOUTME: Unit tests for the disclosure statement crypto (ADR-0020) — hop hashing, statementHash field
// ABOUTME: derivation, and EIP-712 endpoint signature verification. No proofs; fast and offline.

import { describe, it, expect } from 'vitest';
import { Wallet } from 'ethers';
import {
  SNARK_SCALAR_FIELD,
  hashHops,
  statementDigest,
  statementHashField,
  verifyEndpointSignature,
  eip712Domain,
  statementMessage,
  DISCLOSURE_EIP712_TYPES,
} from './index';
import type { DisclosureDomain, DisclosureStatement, Hop } from './index';

const domain: DisclosureDomain = { chainId: 31337, verifyingContract: `0x${'11'.repeat(20)}` };

const hops: Hop[] = [
  { kind: 'H1', endpoint: 'shielder', note: 'N1', shield: { txid: '0xaa', tree: 0, position: 5 } },
  { kind: 'H2', spends: 'N1', proof: 'n1', nullifiedTxid: '0xbb' },
];

function makeStatement(account: string): DisclosureStatement {
  return {
    masterPublicKey: '12345',
    verifier: 'Acme Exchange compliance',
    context: 'source-of-funds for withdrawal 0xbb',
    issuedAt: 1_700_000_000,
    endpoints: [{ role: 'shielder', account }],
    adjudicator: `0x${'00'.repeat(20)}`,
    attributions: [],
    hopsHash: hashHops(hops),
  };
}

describe('disclosure statement (ADR-0020)', () => {
  it('derives a statementHash inside the BN254 scalar field', () => {
    const statement = makeStatement(`0x${'22'.repeat(20)}`);
    const field = statementHashField(domain, statement);
    expect(field).toBeLessThan(SNARK_SCALAR_FIELD);
    // The field element is the full EIP-712 digest reduced mod r.
    expect(field).toBe(BigInt(statementDigest(domain, statement)) % SNARK_SCALAR_FIELD);
  });

  it('hashHops is order-sensitive', () => {
    expect(hashHops(hops)).not.toBe(hashHops([hops[1]!, hops[0]!]));
  });

  it('accepts a real EIP-712 signature and rejects a wrong signer', async () => {
    const signer = new Wallet(`0x${'01'.repeat(32)}`);
    const other = new Wallet(`0x${'02'.repeat(32)}`);
    const statement = makeStatement(signer.address);
    const signature = await signer.signTypedData(eip712Domain(domain), DISCLOSURE_EIP712_TYPES, statementMessage(statement));

    expect(verifyEndpointSignature(domain, statement, signer.address, signature)).toBe(true);
    expect(verifyEndpointSignature(domain, statement, other.address, signature)).toBe(false);
  });

  it('a signature does not verify under a different pool domain', async () => {
    const signer = new Wallet(`0x${'03'.repeat(32)}`);
    const statement = makeStatement(signer.address);
    const signature = await signer.signTypedData(eip712Domain(domain), DISCLOSURE_EIP712_TYPES, statementMessage(statement));
    const otherPool: DisclosureDomain = { chainId: 1, verifyingContract: domain.verifyingContract };
    expect(verifyEndpointSignature(otherPool, statement, signer.address, signature)).toBe(false);
  });
});
