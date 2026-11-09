// ABOUTME: H7 attribution tests (ADR-0020 D20.5) — build a package that claims a channel attribution with
// ABOUTME: real go-nitro co-signed states, check acceptance, and one rejection per H7 check and the no-claim rule.

import { describe, it, beforeAll, expect } from 'vitest';
import { Wallet, Signature, getBytes, getAddress } from 'ethers';
import { buildDisclosurePackage } from './builder';
import { checkDisclosurePackage } from './checker';
import { serializeDisclosurePackage, parseDisclosurePackage } from './serialize';
import { InMemoryDisclosureChainSource, type DisclosureChainData, type NitroSignature } from './chain-source';
import { getChannelId, hashNitroState, recoverNitroSigner, participantDestination, type NitroFixedPart, type NitroSingleAssetExit } from './nitro';
import type { ArtifactSet, ProverAdapter } from '../prover/index';
import type { DisclosureDomain, DisclosurePackage, SignedChannelState, ChannelStatesEntry } from './types';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const APP = '0xdEADbeEF00000000000000000000000000000001';
const POOL = `0x${'11'.repeat(20)}`;
const ADJUDICATOR = `0x${'ad'.repeat(20)}`;
const HUB_CUSTODIAN = `0x${'cc'.repeat(20)}`;
const CHAIN = 31337;
const V1 = 10_000n * 10n ** 6n;
const V2 = 10_400n * 10n ** 6n;
const PAYOUT_DEST = `0x${'7b'.padStart(64, '0')}`; // a shielded note public key, as bytes32
const TX = { deposit: `0x${'d2'.repeat(32)}`, conclude: `0x${'c3'.repeat(32)}` };

const domain: DisclosureDomain = { chainId: CHAIN, verifyingContract: POOL };
const adjScope = { chainId: CHAIN, contract: ADJUDICATOR } as const;

const stubProver: ProverAdapter = {
  prove: async () => { throw new Error('no proof needed for H7'); },
  verify: async () => true,
  close: async () => {},
};
const stubArtifacts: ArtifactSet = { wasm: new Uint8Array(), zkey: new Uint8Array(), vkey: {} };

let user: Wallet;
let hubDelegate: Wallet;
let channelId: string;
let fixedPart: NitroFixedPart;
let pkg: DisclosurePackage;
let baseData: DisclosureChainData;

// Sign the EIP-191 prefixed state hash, as a go-nitro participant does.
async function signState(wallet: Wallet, stateHash: string): Promise<NitroSignature> {
  const sig = Signature.from(await wallet.signMessage(getBytes(stateHash)));
  return { v: sig.v, r: sig.r, s: sig.s };
}

// One USDC single-asset exit with the given (destination, amount, allocationType) tuples.
function usdcExit(allocs: readonly [string, bigint, number][]): NitroSingleAssetExit {
  return {
    asset: USDC,
    assetMetadata: { assetType: 0, metadata: '0x' },
    allocations: allocs.map(([destination, amount, allocationType]) => ({ destination, amount, allocationType, metadata: '0x' })),
  };
}

beforeAll(async () => {
  user = new Wallet(`0x${'01'.repeat(32)}`);
  hubDelegate = new Wallet(`0x${'02'.repeat(32)}`);
  fixedPart = { participants: [user.address, HUB_CUSTODIAN], channelNonce: 1, appDefinition: APP, challengeDuration: 86400 };
  channelId = getChannelId(fixedPart);

  const userDest = participantDestination(user.address);
  const hubDest = participantDestination(HUB_CUSTODIAN);
  // state 0: the deposit allocates V1 to the user; state 1: yield brings the user to V2; state 2 (final):
  // the channel shields the payout to the note PAYOUT_DEST (equals the on-chain finalized outcome).
  const raw: { outcome: NitroSingleAssetExit[]; turnNum: number; isFinal: boolean }[] = [
    { outcome: [usdcExit([[userDest, V1, 0], [hubDest, 0n, 0]])], turnNum: 2, isFinal: false },
    { outcome: [usdcExit([[userDest, V2, 0], [hubDest, 0n, 0]])], turnNum: 4, isFinal: false },
    { outcome: [usdcExit([[PAYOUT_DEST, V2, 3]])], turnNum: 6, isFinal: true },
  ];
  const states: SignedChannelState[] = [];
  for (const s of raw) {
    const stateHash = hashNitroState(channelId, { outcome: s.outcome, appData: '0x', turnNum: s.turnNum, isFinal: s.isFinal });
    states.push({ ...s, appData: '0x', sigs: [await signState(user, stateHash), await signState(hubDelegate, stateHash)] });
  }
  const channelStates: ChannelStatesEntry[] = [{ channelId, fixedPart, states }];

  pkg = await buildDisclosurePackage({
    keyset: { spendingPublicKey: [0n, 0n], spendingPrivateKey: new Uint8Array(32), nullifyingKey: 0n, masterPublicKey: 12345n },
    domain,
    verifier: 'Acme Exchange compliance',
    context: 'yield attribution for channel',
    issuedAt: 1_700_000_000,
    adjudicator: ADJUDICATOR,
    attributions: [{ channelId, participant: user.address }],
    endpoints: [{ role: 'channel-participant', account: user.address }],
    openings: [],
    spends: [],
    hops: [{ kind: 'H7', channelId, participant: user.address, asset: USDC, depositTxid: TX.deposit, concludeTxid: TX.conclude, hubActiveBlock: 200 }],
    channelStates,
    prover: stubProver,
    artifacts: stubArtifacts,
    signEndpoint: async ({ domain: d, types, message }) => user.signTypedData(d, types, message),
  });

  baseData = {
    deposits: [{ ...adjScope, txid: TX.deposit, channelId, asset: USDC, held: V1.toString(), adaptParams: `0x${'00'.repeat(32)}` }],
    finalizedOutcomes: [{ ...adjScope, txid: TX.conclude, channelId, asset: USDC, allocations: [{ destination: PAYOUT_DEST, amount: V2.toString(), allocationType: 3 }] }],
    // A HubCustodian whose delegate is an EOA: EIP-1271 accepts a signature that recovers to the delegate.
    hubSignatureValid: async ({ stateHash, signature }) => {
      try {
        return getAddress(recoverNitroSigner(stateHash, signature)) === getAddress(hubDelegate.address);
      } catch {
        return false;
      }
    },
  };
});

const check = (p: DisclosurePackage, data: DisclosureChainData = baseData) =>
  checkDisclosurePackage({ package: p, source: new InMemoryDisclosureChainSource(data), prover: stubProver, vkey: {} });

const withData = (overrides: Partial<DisclosureChainData>): DisclosureChainData => ({ ...baseData, ...overrides });

// Rebuild channelStates with a mutator, so the user's go-nitro signatures stay valid for the edit.
async function restate(mutate: (s: { outcome: NitroSingleAssetExit[]; turnNum: number; isFinal: boolean }[]) => void): Promise<DisclosurePackage> {
  const userDest = participantDestination(user.address);
  const hubDest = participantDestination(HUB_CUSTODIAN);
  const raw = [
    { outcome: [usdcExit([[userDest, V1, 0], [hubDest, 0n, 0]])], turnNum: 2, isFinal: false },
    { outcome: [usdcExit([[userDest, V2, 0], [hubDest, 0n, 0]])], turnNum: 4, isFinal: false },
    { outcome: [usdcExit([[PAYOUT_DEST, V2, 3]])], turnNum: 6, isFinal: true },
  ];
  mutate(raw);
  const states: SignedChannelState[] = [];
  for (const s of raw) {
    const stateHash = hashNitroState(channelId, { outcome: s.outcome, appData: '0x', turnNum: s.turnNum, isFinal: s.isFinal });
    states.push({ ...s, appData: '0x', sigs: [await signState(user, stateHash), await signState(hubDelegate, stateHash)] });
  }
  return { ...pkg, channelStates: [{ channelId, fixedPart, states }] };
}

describe('selective disclosure — H7 attribution (ADR-0020 D20.5)', () => {
  it('accepts a claimed attribution and reports the user allocation change', async () => {
    const result = await check(pkg);
    expect(result.ok).toBe(true);
    expect(result.learned?.attributions).toEqual([
      { channelId, turnNum: 4, asset: USDC, before: V1.toString(), after: V2.toString() },
    ]);
  });

  it('serializes an attribution package to JSON and checks the round trip', async () => {
    const parsed = parseDisclosurePackage(serializeDisclosurePackage(pkg));
    expect((await check(parsed)).ok).toBe(true);
  });

  it('rejects a package carrying channel states without a claim', async () => {
    const bad = await buildDisclosurePackage({
      keyset: { spendingPublicKey: [0n, 0n], spendingPrivateKey: new Uint8Array(32), nullifyingKey: 0n, masterPublicKey: 12345n },
      domain,
      verifier: 'v',
      context: 'no-claim',
      issuedAt: 1_700_000_000,
      adjudicator: ADJUDICATOR,
      attributions: [],
      endpoints: [],
      openings: [],
      spends: [],
      hops: [],
      channelStates: pkg.channelStates ?? [],
      prover: stubProver,
      artifacts: stubArtifacts,
      signEndpoint: async ({ domain: d, types, message }) => user.signTypedData(d, types, message),
    });
    expect((await check(bad)).failure?.check).toBe('unexpected-channel-states');
  });

  it('rejects a claim whose participant is not a signed endpoint', async () => {
    const bad = { ...pkg, statement: { ...pkg.statement, endpoints: [] } };
    expect((await check(bad)).failure?.check).toBe('attribution-participant');
  });

  it('rejects channel states whose fixed part gives a different channel id', async () => {
    const bad = { ...pkg, channelStates: [{ ...pkg.channelStates![0]!, fixedPart: { ...fixedPart, channelNonce: 999 } }] };
    expect((await check(bad)).failure?.check).toBe('channel-id');
  });

  it('rejects a state with an invalid participant signature', async () => {
    const forged = await restate(() => {});
    const entry = forged.channelStates![0]!;
    const tampered = { ...entry.states[1]!, sigs: [entry.states[0]!.sigs[0]!, entry.states[1]!.sigs[1]!] };
    const bad = { ...forged, channelStates: [{ ...entry, states: [entry.states[0]!, tampered, entry.states[2]!] }] };
    expect((await check(bad)).failure?.check).toBe('state-signatures');
  });

  it('rejects states whose turn numbers do not increase', async () => {
    const bad = await restate((raw) => { raw[1]!.turnNum = 2; });
    expect((await check(bad)).failure?.check).toBe('state-turn-order');
  });

  it('rejects when the first state does not allocate the deposit to the user', async () => {
    const result = await check(pkg, withData({ deposits: [{ ...baseData.deposits![0]!, held: (V1 + 1n).toString() }] }));
    expect(result.failure?.check).toBe('attribution-first-state');
  });

  it('rejects when the last state does not equal the finalized outcome', async () => {
    const result = await check(pkg, withData({
      finalizedOutcomes: [{ ...baseData.finalizedOutcomes![0]!, allocations: [{ destination: PAYOUT_DEST, amount: (V2 + 1n).toString(), allocationType: 3 }] }],
    }));
    expect(result.failure?.check).toBe('attribution-finalized');
  });

  it('rejects an invalid hub EIP-1271 signature', async () => {
    const result = await check(pkg, withData({ hubSignatureValid: async () => false }));
    expect(result.failure?.check).toBe('state-signatures');
  });

  it('rejects a claim with no H7 hop', async () => {
    const bad = await buildDisclosurePackage({
      keyset: { spendingPublicKey: [0n, 0n], spendingPrivateKey: new Uint8Array(32), nullifyingKey: 0n, masterPublicKey: 12345n },
      domain,
      verifier: 'v',
      context: 'no-hop',
      issuedAt: 1_700_000_000,
      adjudicator: ADJUDICATOR,
      attributions: [{ channelId, participant: user.address }],
      endpoints: [{ role: 'channel-participant', account: user.address }],
      openings: [],
      spends: [],
      hops: [],
      prover: stubProver,
      artifacts: stubArtifacts,
      signEndpoint: async ({ domain: d, types, message }) => user.signTypedData(d, types, message),
    });
    expect((await check(bad)).failure?.check).toBe('missing-attribution-hop');
  });
});
