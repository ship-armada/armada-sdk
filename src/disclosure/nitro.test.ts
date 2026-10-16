// ABOUTME: go-nitro parity test (ADR-0020 H7) — recomputes channelId, the state hash and the ECDSA
// ABOUTME: signer in TypeScript and asserts they equal vectors produced by armada-nitro's own contracts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { getAddress } from 'ethers';
import { getChannelId, hashNitroState, recoverNitroSigner } from './nitro';
import type { NitroFixedPart, NitroVariablePart } from './nitro';

interface NitroVector {
  readonly user: string;
  readonly hub: string;
  readonly channelNonce: number;
  readonly appDefinition: string;
  readonly challengeDuration: number;
  readonly asset: string;
  readonly destUser: string;
  readonly destHub: string;
  readonly amtUser: number;
  readonly amtHub: number;
  readonly appData: string;
  readonly turnNum: number;
  readonly isFinal: boolean;
  readonly channelId: string;
  readonly stateHash: string;
  readonly signer: string;
  readonly sigV: number;
  readonly sigR: string;
  readonly sigS: string;
}

const vectorsPath = fileURLToPath(new URL('../../test/vectors/nitro-state-vectors.json', import.meta.url));
// Trusted in-repo fixture (produced by the armada-nitro forge script); one boundary assertion.
const vectorsFile = JSON.parse(readFileSync(vectorsPath, 'utf8')) as { vectors: NitroVector[] };
const vectors = vectorsFile.vectors;

describe('go-nitro parity (ADR-0020 H7)', () => {
  it.each(vectors.map((v, i) => [i, v] as const))('vector %i matches armada-nitro contracts', (_i, v) => {
    const fixedPart: NitroFixedPart = {
      participants: [v.user, v.hub],
      channelNonce: v.channelNonce,
      appDefinition: v.appDefinition,
      challengeDuration: v.challengeDuration,
    };
    const variablePart: NitroVariablePart = {
      outcome: [
        {
          asset: v.asset,
          assetMetadata: { assetType: 0, metadata: '0x' },
          allocations: [
            { destination: v.destUser, amount: BigInt(v.amtUser), allocationType: 0, metadata: '0x' },
            { destination: v.destHub, amount: BigInt(v.amtHub), allocationType: 0, metadata: '0x' },
          ],
        },
      ],
      appData: v.appData,
      turnNum: v.turnNum,
      isFinal: v.isFinal,
    };

    // The channel id and the state hash must match the go-nitro library byte for byte.
    const channelId = getChannelId(fixedPart);
    expect(channelId).toBe(v.channelId);
    expect(hashNitroState(channelId, variablePart)).toBe(v.stateHash);

    // The ECDSA recovery of the EIP-191 prefixed state hash must match the on-chain recoverSigner.
    const recovered = recoverNitroSigner(v.stateHash, { v: v.sigV, r: v.sigR, s: v.sigS });
    expect(getAddress(recovered)).toBe(getAddress(v.signer));
  });
});
