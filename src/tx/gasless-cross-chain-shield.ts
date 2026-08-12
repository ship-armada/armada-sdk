// ABOUTME: Gasless cross-chain shield builder (SPEC §4.6, #410) — the two ShieldData notes + the EIP-712
// ABOUTME: CrossChainShieldIntent for GaslessShieldWrapperClient.gaslessCrossChainShield (fee note bridged, minted on hub).

import { keccak256, AbiCoder, TypedDataEncoder } from 'ethers';
import { buildShieldRequest } from './shield';
import { grossUpShieldFee, type ShieldFeeTiers } from './shield-fee';

const coder = AbiCoder.defaultAbiCoder();

/** On-chain `ShieldData` (CCTPTypes) — a shield note carried across CCTP and minted on the hub. */
export interface ShieldData {
  readonly npk: `0x${string}`;
  readonly value: bigint;
  readonly encryptedBundle: readonly [string, string, string];
  readonly shieldKey: `0x${string}`;
  readonly integrator: `0x${string}`;
}

const SHIELD_DATA_TYPE = 'tuple(bytes32 npk, uint120 value, bytes32[3] encryptedBundle, bytes32 shieldKey, address integrator)';

/** `keccak256(abi.encode(note))` — the per-note hash the CrossChainShieldIntent binds. */
export function hashShieldData(note: ShieldData): `0x${string}` {
  return keccak256(
    coder.encode([SHIELD_DATA_TYPE], [[note.npk, note.value, note.encryptedBundle, note.shieldKey, note.integrator]]),
  ) as `0x${string}`;
}

/** The EIP-712 CrossChainShieldIntent the user signs (binds both notes + the CCTP params). */
export interface CrossChainShieldIntent {
  readonly user: `0x${string}`;
  readonly userNoteHash: `0x${string}`;
  readonly feeNoteHash: `0x${string}`;
  readonly maxFee: bigint;
  readonly minFinalityThreshold: number;
  readonly deadline: bigint;
  readonly nonce: bigint;
}

export interface CrossChainShieldIntentTypedData {
  readonly domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  readonly types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  readonly message: CrossChainShieldIntent;
}

const CROSS_CHAIN_SHIELD_INTENT_TYPES = {
  CrossChainShieldIntent: [
    { name: 'user', type: 'address' },
    { name: 'userNoteHash', type: 'bytes32' },
    { name: 'feeNoteHash', type: 'bytes32' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'minFinalityThreshold', type: 'uint32' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export interface GaslessCrossChainShieldInput {
  readonly clientWrapperAddress: `0x${string}`;
  readonly chainId: number;
  readonly user: `0x${string}`;
  readonly maxFee: bigint;
  readonly minFinalityThreshold: number;
  readonly deadline: bigint;
  readonly nonce: bigint;
  /** The user's cross-chain shielded deposit (`shieldedAddress` is the recipient's HUB 0zk). */
  readonly userShield: { readonly shieldedAddress: string; readonly amount: bigint; readonly tokenAddress: string; readonly integrator: `0x${string}` };
  /** The relayer fee note. When `grossUp` is set, `amount` is the NET target and the SDK grosses it up (§4.6.1). */
  readonly feeShield: {
    readonly shieldedAddress: string;
    readonly amount: bigint;
    readonly tokenAddress: string;
    readonly integrator: `0x${string}`;
    readonly grossUp?: ShieldFeeTiers;
  };
}

/**
 * Assemble a gasless cross-chain shield: the two `ShieldData` notes (user + relayer fee, fee note carried
 * across CCTP and minted on the hub) and the EIP-712 `CrossChainShieldIntent` to sign. The caller signs
 * `typedData` plus a separate EIP-2612 permit (see `buildPermitTypedData`), then submits
 * `gaslessCrossChainShield(params, intentSig, userNote, feeNote)` via the relayer.
 */
export async function buildGaslessCrossChainShield(
  input: GaslessCrossChainShieldInput,
  shieldPrivateKey: Uint8Array,
): Promise<{ userNote: ShieldData; feeNote: ShieldData; typedData: CrossChainShieldIntentTypedData }> {
  const toShieldData = async (
    s: { shieldedAddress: string; amount: bigint; tokenAddress: string; integrator: `0x${string}` },
  ): Promise<ShieldData> => {
    const { shieldRequest } = await buildShieldRequest(s, shieldPrivateKey);
    return {
      npk: shieldRequest.preimage.npk as `0x${string}`,
      value: shieldRequest.preimage.value,
      encryptedBundle: shieldRequest.ciphertext.encryptedBundle,
      shieldKey: shieldRequest.ciphertext.shieldKey as `0x${string}`,
      integrator: s.integrator,
    };
  };

  const userNote = await toShieldData(input.userShield);
  const feeValue = input.feeShield.grossUp !== undefined
    ? grossUpShieldFee(input.feeShield.amount, input.feeShield.grossUp)
    : input.feeShield.amount;
  const feeNote = await toShieldData({ ...input.feeShield, amount: feeValue });

  const typedData: CrossChainShieldIntentTypedData = {
    domain: { name: 'ArmadaGaslessCrossChainShield', version: '1', chainId: input.chainId, verifyingContract: input.clientWrapperAddress },
    types: CROSS_CHAIN_SHIELD_INTENT_TYPES,
    message: {
      user: input.user,
      userNoteHash: hashShieldData(userNote),
      feeNoteHash: hashShieldData(feeNote),
      maxFee: input.maxFee,
      minFinalityThreshold: input.minFinalityThreshold,
      deadline: input.deadline,
      nonce: input.nonce,
    },
  };
  return { userNote, feeNote, typedData };
}

/** The EIP-712 digest the client wrapper verifies for a CrossChainShieldIntent. */
export function hashCrossChainShieldIntent(typedData: CrossChainShieldIntentTypedData): `0x${string}` {
  return TypedDataEncoder.hash(
    typedData.domain,
    typedData.types as Record<string, Array<{ name: string; type: string }>>,
    typedData.message,
  ) as `0x${string}`;
}
