// ABOUTME: Tests for the shield-request builder (§4.6, #410) — a built shield decrypts back to the
// ABOUTME: recipient via tryDecryptShield (value/token/random), and a stranger cannot claim it.

import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise, getTokenDataERC20, getTokenDataHash } from '../core/index';
import { deriveKeyset, type Keyset } from '../wallet/derive';
import { tryDecryptShield, type DecodedShieldCommitment } from '../sync/index';
import { buildShieldRequest, generateShieldPrivateKey, type ShieldRequest } from './shield';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const seed = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const strip = (h: string): string => (h.startsWith('0x') ? h.slice(2) : h);

// Assemble the on-chain shield commitment shape (no-0x) the scanner would decode from a Shield event.
const asCommitment = (req: ShieldRequest): DecodedShieldCommitment => ({
  tree: 0,
  position: 0,
  blockNumber: 1,
  txid: '0x' + 'ab'.repeat(32),
  hash: strip(req.preimage.npk),
  npk: strip(req.preimage.npk),
  tokenData: req.preimage.token,
  value: req.preimage.value,
  encryptedBundle: [strip(req.ciphertext.encryptedBundle[0]), strip(req.ciphertext.encryptedBundle[1]), strip(req.ciphertext.encryptedBundle[2])],
  shieldKey: strip(req.ciphertext.shieldKey),
});
const receiverKeys = (k: Keyset) => ({
  addressData: { masterPublicKey: k.masterPublicKey, viewingPublicKey: k.viewingPublicKey },
  viewingPrivateKey: k.viewingPrivateKey,
});

describe('shield-request builder (§4.6, #410)', () => {
  let receiver: Keyset;
  let stranger: Keyset;

  beforeAll(async () => {
    await initPoseidonPromise;
    receiver = await deriveKeyset(seed(0x22));
    stranger = await deriveKeyset(seed(0x33));
  });

  it('builds a decryptable ERC20 shield addressed to the recipient', async () => {
    const amount = 5_000_000n;
    const { shieldRequest, random } = await buildShieldRequest(
      { railgunAddress: receiver.railgunAddress, amount, tokenAddress: USDC },
      generateShieldPrivateKey(),
    );

    // On-chain preimage shape.
    expect(shieldRequest.preimage.value).toBe(amount);
    expect(shieldRequest.preimage.npk).toMatch(/^0x[0-9a-f]{64}$/);
    expect(shieldRequest.ciphertext.encryptedBundle).toHaveLength(3);

    // The recipient recovers value + token + random via the shield ECIES bundle.
    const owned = await tryDecryptShield(asCommitment(shieldRequest), receiverKeys(receiver));
    expect(owned).toBeDefined();
    expect(owned!.value).toBe(amount);
    expect(owned!.tokenHash).toBe(getTokenDataHash(getTokenDataERC20(USDC)));
    expect(owned!.random).toBe(random);
  });

  it('is not claimable by a stranger', async () => {
    const { shieldRequest } = await buildShieldRequest(
      { railgunAddress: receiver.railgunAddress, amount: 1n, tokenAddress: USDC },
      generateShieldPrivateKey(),
    );
    expect(await tryDecryptShield(asCommitment(shieldRequest), receiverKeys(stranger))).toBeUndefined();
  });

  it('reproduces the commitment (npk/token/value + shieldKey) when an explicit random is supplied', async () => {
    // WHY: a consumer runs this builder as a differential against another shield implementation.
    // The COMMITMENT fields — npk = Poseidon(masterPublicKey, random), token, value — plus the
    // ephemeral `shieldKey` (public key of shieldPrivateKey) are deterministic given the same
    // key + random, so parity is byte-checkable. The `encryptedBundle` is deliberately NOT — it
    // uses a fresh AES-GCM IV per call, so its correctness property is decryptability (the decrypt
    // test above), not byte-equality. A differential must compare the preimage + shieldKey only.
    const key = generateShieldPrivateKey();
    const random = 'ab'.repeat(16); // 16 bytes hex, no 0x
    const input = { railgunAddress: receiver.railgunAddress, amount: 7_000_000n, tokenAddress: USDC };
    const r1 = await buildShieldRequest(input, key, random);
    const r2 = await buildShieldRequest(input, key, random);
    expect(r1.random).toBe(random);
    expect(r2.shieldRequest.preimage).toEqual(r1.shieldRequest.preimage);
    expect(r2.shieldRequest.ciphertext.shieldKey).toBe(r1.shieldRequest.ciphertext.shieldKey);
    // Fresh IV per call — the bundle is intentionally not byte-reproducible.
    expect(r2.shieldRequest.ciphertext.encryptedBundle).not.toEqual(r1.shieldRequest.ciphertext.encryptedBundle);
  });

  it('generates a fresh random per call when none is supplied', async () => {
    // WHY: the default path must stay non-deterministic — reused randomness across deposits would
    // link notes. Two default-random builds of the same note differ at the commitment (npk).
    const key = generateShieldPrivateKey();
    const input = { railgunAddress: receiver.railgunAddress, amount: 7_000_000n, tokenAddress: USDC };
    const a = await buildShieldRequest(input, key);
    const b = await buildShieldRequest(input, key);
    expect(a.random).not.toBe(b.random);
    expect(a.shieldRequest.preimage.npk).not.toBe(b.shieldRequest.preimage.npk);
  });

  it('generateShieldPrivateKey returns 32 random bytes', () => {
    const a = generateShieldPrivateKey();
    expect(a).toHaveLength(32);
    expect(generateShieldPrivateKey()).not.toEqual(a);
  });
});
