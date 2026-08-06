// ABOUTME: Gasless shield tests (§4.6, #410) — requestsHash + EIP-712 intent digest vs foundry `cast`
// ABOUTME: goldens (from GaslessShieldWrapper), plus a buildGaslessShield fee-note round-trip.

import { describe, it, expect, beforeAll } from 'vitest';
import { initPoseidonPromise, getTokenDataERC20, getTokenDataHash } from '../core/index';
import { deriveKeyset, type Keyset } from '../wallet/derive';
import { tryDecryptShield, type DecodedShieldCommitment } from '../sync/index';
import { generateShieldPrivateKey, type ShieldRequest } from './shield';
import { hashShieldRequests, buildShieldIntentTypedData, hashShieldIntent, buildGaslessShield } from './gasless-shield';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const z = (prefix: string): string => `0x${prefix}${'00'.repeat(31)}`;
const seed = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const strip = (h: string): string => (h.startsWith('0x') ? h.slice(2) : h);

// The fixed ShieldRequest the requestsHash golden was computed over.
const FIXED_REQUEST: ShieldRequest = {
  preimage: { npk: z('11'), token: { tokenType: 0, tokenAddress: USDC, tokenSubID: '0' }, value: 1_000_000n },
  ciphertext: { encryptedBundle: [z('a1'), z('a2'), z('a3')], shieldKey: z('b1') },
};

// Golden values from foundry `cast` (abi.encode + keccak / EIP-712 domain+struct hashing).
const GOLDEN = {
  requestsHash: '0x58b047e247105e49655e15b5c27d5fad35d7654c370673ba41b0ade8d9e2ed76',
  intentDigest: '0xf4d7dc2663891630452dd7aa82ce08f75f5d36ffbefedcc1a0ab254984196979',
};

describe('gasless shield (§4.6, #410)', () => {
  beforeAll(async () => {
    await initPoseidonPromise;
  });

  it('hashShieldRequests matches the contract abi.encode+keccak golden', () => {
    expect(hashShieldRequests([FIXED_REQUEST])).toBe(GOLDEN.requestsHash);
  });

  it('hashShieldIntent matches the EIP-712 digest the wrapper verifies', () => {
    const typedData = buildShieldIntentTypedData({
      wrapperAddress: '0x00000000000000000000000000000000000000aa',
      chainId: 31337,
      intent: {
        user: '0x00000000000000000000000000000000deadbeef',
        requestsHash: z('cc') as `0x${string}`,
        integrator: '0x0000000000000000000000000000000000000000',
        deadline: 1000n,
        nonce: 0n,
      },
    });
    expect(typedData.domain.name).toBe('ArmadaGaslessShield');
    expect(hashShieldIntent(typedData)).toBe(GOLDEN.intentDigest);
  });

  it('buildGaslessShield binds requestsHash and shields a decryptable relayer fee note', async () => {
    const user: Keyset = await deriveKeyset(seed(0x11));
    const relayer: Keyset = await deriveKeyset(seed(0x22));
    const feeAmount = 50_000n;

    const { shieldRequests, requestsHash, typedData } = await buildGaslessShield(
      {
        wrapperAddress: '0x00000000000000000000000000000000000000aa',
        chainId: 31337,
        user: '0x00000000000000000000000000000000deadbeef',
        integrator: '0x0000000000000000000000000000000000000000',
        deadline: 2000n,
        nonce: 3n,
        userShield: { railgunAddress: user.railgunAddress, amount: 10_000_000n, tokenAddress: USDC },
        feeShield: { railgunAddress: relayer.railgunAddress, amount: feeAmount, tokenAddress: USDC },
      },
      generateShieldPrivateKey(),
    );

    expect(shieldRequests).toHaveLength(2); // user note + fee note
    // The signed intent must bind exactly this array.
    expect(requestsHash).toBe(hashShieldRequests(shieldRequests));
    expect(typedData.message.requestsHash).toBe(requestsHash);
    expect(typedData.message.nonce).toBe(3n);

    // The fee note (2nd) is a shield to the relayer's 0zk — recoverable by the relayer's viewing key.
    const feeReq = shieldRequests[1]!;
    const commitment: DecodedShieldCommitment = {
      tree: 0, position: 0, blockNumber: 1, txid: '0x' + 'ab'.repeat(32),
      hash: strip(feeReq.preimage.npk), npk: strip(feeReq.preimage.npk),
      tokenData: feeReq.preimage.token, value: feeReq.preimage.value,
      encryptedBundle: [strip(feeReq.ciphertext.encryptedBundle[0]), strip(feeReq.ciphertext.encryptedBundle[1]), strip(feeReq.ciphertext.encryptedBundle[2])],
      shieldKey: strip(feeReq.ciphertext.shieldKey),
    };
    const owned = await tryDecryptShield(commitment, {
      addressData: { masterPublicKey: relayer.masterPublicKey, viewingPublicKey: relayer.viewingPublicKey },
      viewingPrivateKey: relayer.viewingPrivateKey,
    });
    expect(owned?.value).toBe(feeAmount);
    expect(owned?.tokenHash).toBe(getTokenDataHash(getTokenDataERC20(USDC)));
  });
});
