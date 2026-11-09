// ABOUTME: End-to-end disclosure tests (ADR-0020) with REAL Groth16 proofs from the armada-circuits dev
// ABOUTME: artifacts. Builds the Aave-hub example package, checks acceptance, and one rejection per check.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet, AbiCoder, keccak256 } from 'ethers';
import {
  initPoseidonPromise,
  poseidon,
  ShieldNote,
  getTokenDataERC20,
  getTokenDataHash,
  type TokenData,
} from '../core/index';
import { createSnarkjsProver } from '../prover/index';
import type { ArtifactSet, ProverAdapter } from '../prover/index';
import { buildDisclosurePackage } from './builder';
import { checkDisclosurePackage } from './checker';
import { InMemoryDisclosureChainSource, type DisclosureChainData } from './chain-source';
import { loadDisclosureArtifacts } from '../node/index';
import type { DisclosureSigningKeys } from './circuit';
import type {
  DisclosureDomain,
  DisclosurePackage,
  Hop,
  EndpointSignature,
} from './types';
import type { EndpointSigner } from './builder';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const CHANNEL = `0x${'ab'.repeat(32)}`;
const TX = {
  shield: `0x${'a1'.repeat(32)}`,
  deposit: `0x${'d2'.repeat(32)}`,
  conclude: `0x${'c3'.repeat(32)}`,
  unshield: `0x${'f4'.repeat(32)}`,
};
const V1 = 10_000n * 10n ** 6n;
const V2 = 10_400n * 10n ** 6n;
const R1 = `0x${'11'.repeat(16)}`;
const R2 = `0x${'22'.repeat(16)}`;

const artifactsDir =
  process.env.ARMADA_DISCLOSURE_ARTIFACTS ??
  fileURLToPath(new URL('../../../armada-circuits/build/disclosure', import.meta.url));

const POOL = `0x${'11'.repeat(20)}`;
const ADJUDICATOR = `0x${'ad'.repeat(20)}`;
const CHAIN = 31337;
const domain: DisclosureDomain = { chainId: CHAIN, verifyingContract: POOL };
const poolScope = { chainId: CHAIN, contract: POOL } as const;
const adjScope = { chainId: CHAIN, contract: ADJUDICATOR } as const;

let prover: ProverAdapter;
let artifacts: ArtifactSet;
let usdc: TokenData;
let walletA: Wallet;
let walletB: Wallet;
let pkg: DisclosurePackage;
let baseData: DisclosureChainData;
let keys: DisclosureSigningKeys;

interface KeysetVectorFile {
  readonly vectors: readonly {
    readonly keyset: {
      readonly spendingPublicKey: [string, string];
      readonly spendingPrivateKey: string;
      readonly nullifyingKey: string;
      readonly masterPublicKey: string;
    };
  }[];
}

/** Keys of keyset-vectors.json vector 0 (all-ones), as the signing-key shape the builder needs. */
function loadKeys(): DisclosureSigningKeys {
  const vectorsPath = fileURLToPath(new URL('../../test/vectors/keyset-vectors.json', import.meta.url));
  // Trusted in-repo test fixture; one boundary assertion to a named shape (no runtime schema here).
  const file = JSON.parse(readFileSync(vectorsPath, 'utf8')) as KeysetVectorFile;
  const ks = file.vectors[0]!.keyset;
  return {
    spendingPublicKey: [BigInt(ks.spendingPublicKey[0]), BigInt(ks.spendingPublicKey[1])],
    spendingPrivateKey: Uint8Array.from(Buffer.from(ks.spendingPrivateKey.slice(2), 'hex')),
    nullifyingKey: BigInt(ks.nullifyingKey),
    masterPublicKey: BigInt(ks.masterPublicKey),
  };
}

const signerFor = (wallets: Wallet[]): EndpointSigner => async ({ account, domain: d, types, message }) => {
  const wallet = wallets.find((w) => w.address === account);
  if (wallet === undefined) throw new Error(`no wallet for ${account}`);
  return wallet.signTypedData(d, types, message);
};

beforeAll(async () => {
  await initPoseidonPromise;
  if (!existsSync(join(artifactsDir, 'final.zkey'))) {
    throw new Error(
      `disclosure artifacts not found at ${artifactsDir}. Build armada-circuits/build/disclosure or set ARMADA_DISCLOSURE_ARTIFACTS.`,
    );
  }
  prover = createSnarkjsProver();
  artifacts = await loadDisclosureArtifacts(artifactsDir);
  usdc = getTokenDataERC20(USDC);
  walletA = new Wallet(`0x${'01'.repeat(32)}`);
  walletB = new Wallet(`0x${'02'.repeat(32)}`);

  keys = loadKeys();
  const k = keys;
  const M = k.masterPublicKey;
  const tokenHash = getTokenDataHash(usdc);

  const npk1 = ShieldNote.getNotePublicKey(M, R1);
  const npk2 = ShieldNote.getNotePublicKey(M, R2);
  const commitment1 = ShieldNote.getShieldNoteHash(npk1, tokenHash, V1);
  const commitment2 = ShieldNote.getShieldNoteHash(npk2, tokenHash, V2);
  const nullifier1 = poseidon([k.nullifyingKey, 5n]);
  const nullifier2 = poseidon([k.nullifyingKey, 9n]);

  const hops: Hop[] = [
    { kind: 'H1', endpoint: 'shielder', note: 'N1', shield: { txid: TX.shield, tree: 0, position: 5 } },
    { kind: 'H2', spends: 'N1', proof: 'n1', nullifiedTxid: TX.deposit },
    { kind: 'H4', proof: 'n1', channelId: CHANNEL, expectedHeld: V1.toString(), asset: USDC, depositTxid: TX.deposit },
    { kind: 'H5', note: 'N2', channelId: CHANNEL, concludeTxid: TX.conclude, shield: { txid: TX.conclude, tree: 0, position: 9 } },
    { kind: 'H2', spends: 'N2', proof: 'n2', nullifiedTxid: TX.unshield },
    { kind: 'H6', spends: 'N2', proof: 'n2', endpoint: 'withdrawer', unshieldTxid: TX.unshield },
  ];

  pkg = await buildDisclosurePackage({
    keyset: k,
    domain,
    verifier: 'Acme Exchange compliance',
    context: 'source-of-funds for USDC withdrawal to 0xB',
    issuedAt: 1_700_000_000,
    adjudicator: ADJUDICATOR,
    endpoints: [
      { role: 'shielder', account: walletA.address },
      { role: 'withdrawer', account: walletB.address },
    ],
    openings: [
      { label: 'N1', random: R1, token: usdc, value: V1, tree: 0, position: 5 },
      { label: 'N2', random: R2, token: usdc, value: V2, tree: 0, position: 9 },
    ],
    spends: [
      { id: 'n1', opening: 'N1' },
      { id: 'n2', opening: 'N2' },
    ],
    hops,
    prover,
    artifacts,
    signEndpoint: signerFor([walletA, walletB]),
  });

  const adaptParams = keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [CHANNEL, V1]));

  baseData = {
    shields: [
      { ...poolScope, tree: 0, position: 5, blockNumber: 100, txid: TX.shield, hash: commitment1.toString(16), npk: npk1.toString(16), tokenData: usdc, value: V1, encryptedBundle: ['00', '00', '00'], shieldKey: '00' },
      { ...poolScope, tree: 0, position: 9, blockNumber: 400, txid: TX.conclude, hash: commitment2.toString(16), npk: npk2.toString(16), tokenData: usdc, value: V2, encryptedBundle: ['00', '00', '00'], shieldKey: '00' },
    ],
    nullifiers: [
      { ...poolScope, tree: 0, nullifier: nullifier1, txid: TX.deposit, blockNumber: 200 },
      { ...poolScope, tree: 0, nullifier: nullifier2, txid: TX.unshield, blockNumber: 500 },
    ],
    unshields: [{ ...poolScope, to: walletB.address, tokenData: usdc, amount: V2, fee: 0n, blockNumber: 500, txid: TX.unshield }],
    deposits: [{ ...adjScope, txid: TX.deposit, channelId: CHANNEL, asset: USDC, held: V1.toString(), adaptParams }],
    finalizedOutcomes: [
      { ...adjScope, txid: TX.conclude, channelId: CHANNEL, asset: USDC, allocations: [{ destination: `0x${npk2.toString(16)}`, amount: V2.toString(), allocationType: 3 }] },
    ],
    senders: { [TX.shield]: walletA.address },
  };
}, 120_000);

afterAll(async () => {
  await prover?.close();
});

const check = (p: DisclosurePackage, data: DisclosureChainData = baseData) =>
  checkDisclosurePackage({ package: p, source: new InMemoryDisclosureChainSource(data), prover, vkey: artifacts.vkey });

const withData = (overrides: Partial<DisclosureChainData>): DisclosureChainData => ({ ...baseData, ...overrides });

describe('selective disclosure — Aave hub example (ADR-0020)', () => {
  it('accepts a complete, valid package', async () => {
    const result = await check(pkg);
    expect(result.ok).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.learned?.masterPublicKey).toBe(pkg.statement.masterPublicKey);
    expect(result.learned?.transactionIds).toEqual(
      expect.arrayContaining([TX.shield, TX.deposit, TX.conclude, TX.unshield]),
    );
    expect(result.learned?.channelIds).toEqual([CHANNEL]);
  });

  it('rejects an unsupported package version', async () => {
    const bad = { ...pkg, version: 2 as unknown as 1 };
    expect((await check(bad)).failure?.check).toBe('package-version');
  });

  it('rejects a tampered hopsHash', async () => {
    const bad = { ...pkg, statement: { ...pkg.statement, hopsHash: `0x${'00'.repeat(32)}` } };
    expect((await check(bad)).failure?.check).toBe('statement-hops-hash');
  });

  it('rejects an endpoint signature from the wrong EOA', async () => {
    const wrongSig = await walletB.signTypedData(
      { name: 'ArmadaSelectiveDisclosure', version: '1', chainId: domain.chainId, verifyingContract: domain.verifyingContract },
      { Statement: [
        { name: 'masterPublicKey', type: 'uint256' },
        { name: 'verifier', type: 'string' },
        { name: 'context', type: 'string' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'endpoints', type: 'Endpoint[]' },
        { name: 'hopsHash', type: 'bytes32' },
      ], Endpoint: [ { name: 'role', type: 'string' }, { name: 'account', type: 'address' } ] },
      { ...pkg.statement, endpoints: pkg.statement.endpoints.map((e) => ({ role: e.role, account: e.account })) },
    );
    const sigs: EndpointSignature[] = pkg.endpointSignatures.map((s) =>
      s.role === 'shielder' ? { ...s, signature: wrongSig } : s,
    );
    const bad = { ...pkg, endpointSignatures: sigs };
    expect((await check(bad)).failure?.check).toBe('endpoint-signature');
  });

  it('rejects a hop that references a missing opening', async () => {
    const bad = { ...pkg, openings: pkg.openings.filter((o) => o.label !== 'N1') };
    expect((await check(bad)).failure?.check).toBe('hop-reference');
  });

  it('rejects an opening for a different masterPublicKey', async () => {
    const bad = { ...pkg, openings: pkg.openings.map((o) => (o.label === 'N1' ? { ...o, masterPublicKey: '999' } : o)) };
    expect((await check(bad)).failure?.check).toBe('opening-master-public-key');
  });

  it('rejects an opening whose npk is not Poseidon(M, random)', async () => {
    const bad = { ...pkg, openings: pkg.openings.map((o) => (o.label === 'N1' ? { ...o, npk: '0x1' } : o)) };
    expect((await check(bad)).failure?.check).toBe('opening-npk');
  });

  it('rejects a shield commitment that does not match the opened note', async () => {
    // Change N1's value so the recomputed commitment no longer matches the Shield event's leaf.
    const bad = { ...pkg, openings: pkg.openings.map((o) => (o.label === 'N1' ? { ...o, value: (V1 + 1n).toString() } : o)) };
    expect((await check(bad)).failure?.check).toBe('shield-commitment');
  });

  it('rejects a Shield transaction sent by a different address', async () => {
    const result = await check(pkg, withData({ senders: { [TX.shield]: walletB.address } }));
    expect(result.failure?.check).toBe('shield-sender');
  });

  it('rejects a proof whose statementHash is not the statement hash', async () => {
    const bad = { ...pkg, proofs: pkg.proofs.map((p) => (p.id === 'n1' ? { ...p, statementHash: '1' } : p)) };
    expect((await check(bad)).failure?.check).toBe('proof-statement-hash');
  });

  it('rejects a proof whose masterPublicKey is not the statement masterPublicKey', async () => {
    const bad = { ...pkg, proofs: pkg.proofs.map((p) => (p.id === 'n1' ? { ...p, masterPublicKey: '1' } : p)) };
    expect((await check(bad)).failure?.check).toBe('proof-master-public-key');
  });

  it('rejects a proof that does not verify for its public signals', async () => {
    const bad = { ...pkg, proofs: pkg.proofs.map((p) => (p.id === 'n1' ? { ...p, leafIndex: 4 } : p)) };
    expect((await check(bad)).failure?.check).toBe('proof-verification');
  });

  it('rejects a nullifier that is not in the Nullified event', async () => {
    const result = await check(pkg, withData({ nullifiers: baseData.nullifiers!.filter((n) => n.txid !== TX.deposit) }));
    expect(result.failure?.check).toBe('nullifier-event');
  });

  it('rejects a deposit whose adaptParams is not the channel binding', async () => {
    const result = await check(pkg, withData({ deposits: [{ ...baseData.deposits![0]!, adaptParams: `0x${'00'.repeat(32)}` }] }));
    expect(result.failure?.check).toBe('deposit-binding');
  });

  it('rejects a missing Deposited event', async () => {
    const result = await check(pkg, withData({ deposits: [] }));
    expect(result.failure?.check).toBe('deposited-event');
  });

  it('rejects a finalized outcome with no SHIELD allocation to the payout note', async () => {
    const result = await check(pkg, withData({
      finalizedOutcomes: [{ ...baseData.finalizedOutcomes![0]!, allocations: [{ destination: '0x01', amount: V2.toString(), allocationType: 3 }] }],
    }));
    expect(result.failure?.check).toBe('finalized-shield-allocation');
  });

  it('rejects a missing Unshield to the withdrawal EOA', async () => {
    const result = await check(pkg, withData({ unshields: [] }));
    expect(result.failure?.check).toBe('unshield-event');
  });
});

describe('selective disclosure — H2 spend-leaf linkage (ADR-0020)', () => {
  it('rejects a proof whose leaf is not the spent note position', async () => {
    const minimal = await buildDisclosurePackage({
      keyset: keys,
      domain,
      verifier: 'v',
      context: 'spend-leaf',
      issuedAt: 1_700_000_000,
      endpoints: [],
      openings: [{ label: 'N1', random: R1, token: usdc, value: V1, tree: 0, position: 5 }],
      spends: [{ id: 'n1', opening: 'N1' }],
      hops: [{ kind: 'H2', spends: 'N1', proof: 'n1', nullifiedTxid: TX.deposit }],
      prover,
      artifacts,
      signEndpoint: signerFor([]),
    });
    const nullifier1 = poseidon([keys.nullifyingKey, 5n]);
    const data: DisclosureChainData = { nullifiers: [{ ...poolScope, tree: 0, nullifier: nullifier1, txid: TX.deposit, blockNumber: 1 }] };
    expect((await check(minimal, data)).ok).toBe(true);
    const bad = { ...minimal, openings: minimal.openings.map((o) => ({ ...o, position: 6 })) };
    expect((await check(bad, data)).failure?.check).toBe('spend-leaf-position');
  }, 60_000);
});

describe('selective disclosure — H3 output-note opening (ADR-0020)', () => {
  it('accepts an opened output note and rejects a non-matching Transact commitment', async () => {
    const minimal = await buildDisclosurePackage({
      keyset: keys,
      domain,
      verifier: 'v',
      context: 'h3',
      issuedAt: 1_700_000_000,
      endpoints: [],
      openings: [{ label: 'N3', random: R1, token: usdc, value: V1, tree: 0, position: 7 }],
      spends: [],
      hops: [{ kind: 'H3', note: 'N3', transact: { txid: TX.conclude, tree: 0, position: 7 } }],
      prover,
      artifacts,
      signEndpoint: signerFor([]),
    });
    const npk3 = ShieldNote.getNotePublicKey(keys.masterPublicKey, R1);
    const commitment3 = ShieldNote.getShieldNoteHash(npk3, getTokenDataHash(usdc), V1);
    const ciphertext = { ciphertext: ['00', '00', '00', '00'], blindedSenderViewingKey: new Uint8Array(32), blindedReceiverViewingKey: new Uint8Array(32), memo: '', annotationData: '' };
    const good: DisclosureChainData = { transacts: [{ ...poolScope, tree: 0, position: 7, blockNumber: 1, txid: TX.conclude, hash: commitment3.toString(16), ciphertext }] };
    expect((await check(minimal, good)).ok).toBe(true);
    const bad: DisclosureChainData = { transacts: [{ ...poolScope, tree: 0, position: 7, blockNumber: 1, txid: TX.conclude, hash: (commitment3 + 1n).toString(16), ciphertext }] };
    expect((await check(minimal, bad)).failure?.check).toBe('transact-commitment');
  }, 60_000);
});

describe('selective disclosure — H4 funding nullifier (F1 regression, ADR-0020)', () => {
  // An H4 hop with NO paired H2 hop and NO Nullified event. The checker must tie the disclosed
  // proof's nullifier to the deposit transaction; otherwise a prover claims another wallet's deposit.
  it('rejects an H4 deposit whose funding nullifier is not in the deposit transaction', async () => {
    const minimal = await buildDisclosurePackage({
      keyset: keys,
      domain,
      verifier: 'v',
      context: 'f1-h4',
      issuedAt: 1_700_000_000,
      adjudicator: ADJUDICATOR,
      endpoints: [],
      openings: [{ label: 'N1', random: R1, token: usdc, value: V1, tree: 0, position: 5 }],
      spends: [{ id: 'n1', opening: 'N1' }],
      hops: [{ kind: 'H4', proof: 'n1', channelId: CHANNEL, expectedHeld: V1.toString(), asset: USDC, depositTxid: TX.deposit }],
      prover,
      artifacts,
      signEndpoint: signerFor([]),
    });
    const adaptParams = keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [CHANNEL, V1]));
    const deposit = { ...adjScope, txid: TX.deposit, channelId: CHANNEL, asset: USDC, held: V1.toString(), adaptParams };
    const nullifier1 = poseidon([keys.nullifyingKey, 5n]);

    // No Nullified event: the funding nullifier was never published in the deposit transaction.
    const noNullifier: DisclosureChainData = { deposits: [deposit], nullifiers: [] };
    expect((await check(minimal, noNullifier)).failure?.check).toBe('nullifier-event');

    // With the funding nullifier present, the same package passes.
    const withNullifier: DisclosureChainData = {
      deposits: [deposit],
      nullifiers: [{ ...poolScope, tree: 0, nullifier: nullifier1, txid: TX.deposit, blockNumber: 1 }],
    };
    expect((await check(minimal, withNullifier)).ok).toBe(true);
  }, 60_000);
});

describe('selective disclosure — chain scope (F3 regression, D20.6)', () => {
  const WRONG_CONTRACT = `0x${'99'.repeat(20)}`;

  it('rejects an event from a different chain', async () => {
    const data = { ...baseData, nullifiers: baseData.nullifiers!.map((n) => (n.txid === TX.deposit ? { ...n, chainId: 999 } : n)) };
    expect((await check(pkg, data)).failure?.check).toBe('event-chain-mismatch');
  });

  it('rejects a pool event from a different contract', async () => {
    const data = { ...baseData, shields: baseData.shields!.map((s) => (s.txid === TX.shield ? { ...s, contract: WRONG_CONTRACT } : s)) };
    expect((await check(pkg, data)).failure?.check).toBe('event-contract-mismatch');
  });

  it('rejects an adjudicator event from a different contract', async () => {
    const data = { ...baseData, deposits: baseData.deposits!.map((d) => ({ ...d, contract: WRONG_CONTRACT })) };
    expect((await check(pkg, data)).failure?.check).toBe('event-contract-mismatch');
  });

  it('rejects a channel hop when the statement names no adjudicator', async () => {
    const minimal = await buildDisclosurePackage({
      keyset: keys,
      domain,
      verifier: 'v',
      context: 'no-adjudicator',
      issuedAt: 1_700_000_000,
      endpoints: [],
      openings: [{ label: 'N1', random: R1, token: usdc, value: V1, tree: 0, position: 5 }],
      spends: [{ id: 'n1', opening: 'N1' }],
      hops: [{ kind: 'H4', proof: 'n1', channelId: CHANNEL, expectedHeld: V1.toString(), asset: USDC, depositTxid: TX.deposit }],
      prover,
      artifacts,
      signEndpoint: signerFor([]),
    });
    const adaptParams = keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256'], [CHANNEL, V1]));
    const nullifier1 = poseidon([keys.nullifyingKey, 5n]);
    const data: DisclosureChainData = {
      deposits: [{ ...adjScope, txid: TX.deposit, channelId: CHANNEL, asset: USDC, held: V1.toString(), adaptParams }],
      nullifiers: [{ ...poolScope, tree: 0, nullifier: nullifier1, txid: TX.deposit, blockNumber: 1 }],
    };
    expect((await check(minimal, data)).failure?.check).toBe('missing-adjudicator');
  }, 60_000);
});
