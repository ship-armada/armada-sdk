// ABOUTME: Gasless shield builder (SPEC §4.6, #410) — the EIP-712 ShieldIntent + requestsHash the user
// ABOUTME: signs for GaslessShieldWrapper.gaslessShield (permit-pulled, relayer-submitted two-note shield).

import { keccak256, AbiCoder, TypedDataEncoder } from 'ethers';
import { buildShieldRequest, type ShieldRequest } from './shield';
import { grossUpShieldFee, type ShieldFeeTiers } from './shield-fee';

const coder = AbiCoder.defaultAbiCoder();

// The on-chain ShieldRequest[] ABI (Railgun CommitmentPreimage + ShieldCiphertext).
const SHIELD_REQUEST_ARRAY_TYPE =
  'tuple(tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) preimage, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) ciphertext)[]';

/**
 * `keccak256(abi.encode(shieldRequests))` — the digest the ShieldIntent binds so the relayer cannot
 * alter any note's recipient, value, or ciphertext.
 */
export function hashShieldRequests(shieldRequests: readonly ShieldRequest[]): `0x${string}` {
  const tuples = shieldRequests.map((r) => [
    [r.preimage.npk, [r.preimage.token.tokenType, r.preimage.token.tokenAddress, r.preimage.token.tokenSubID], r.preimage.value],
    [r.ciphertext.encryptedBundle, r.ciphertext.shieldKey],
  ]);
  return keccak256(coder.encode([SHIELD_REQUEST_ARRAY_TYPE], [tuples])) as `0x${string}`;
}

/** The EIP-712 ShieldIntent message the user signs (binds the whole note array + replay params). */
export interface ShieldIntent {
  readonly user: `0x${string}`;
  readonly requestsHash: `0x${string}`;
  readonly integrator: `0x${string}`;
  readonly deadline: bigint;
  readonly nonce: bigint;
}

export interface ShieldIntentTypedData {
  readonly domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  readonly types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  readonly message: ShieldIntent;
}

const SHIELD_INTENT_TYPES = {
  ShieldIntent: [
    { name: 'user', type: 'address' },
    { name: 'requestsHash', type: 'bytes32' },
    { name: 'integrator', type: 'address' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

/** EIP-712 typed data for `GaslessShieldWrapper` (domain `ArmadaGaslessShield`/`1`) — sign with the user's key. */
export function buildShieldIntentTypedData(params: {
  wrapperAddress: `0x${string}`;
  chainId: number;
  intent: ShieldIntent;
}): ShieldIntentTypedData {
  return {
    domain: { name: 'ArmadaGaslessShield', version: '1', chainId: params.chainId, verifyingContract: params.wrapperAddress },
    types: SHIELD_INTENT_TYPES,
    message: params.intent,
  };
}

/** The EIP-712 digest the wrapper verifies (`_hashTypedDataV4(structHash)`). */
export function hashShieldIntent(typedData: ShieldIntentTypedData): `0x${string}` {
  return TypedDataEncoder.hash(
    typedData.domain,
    typedData.types as Record<string, Array<{ name: string; type: string }>>,
    typedData.message,
  ) as `0x${string}`;
}

export interface GaslessShieldInput {
  readonly wrapperAddress: `0x${string}`;
  readonly chainId: number;
  readonly user: `0x${string}`;
  readonly integrator: `0x${string}`;
  readonly deadline: bigint;
  readonly nonce: bigint;
  /** The user's own shielded deposit. */
  readonly userShield: { readonly shieldedAddress: string; readonly amount: bigint; readonly tokenAddress: string };
  /**
   * The relayer's fee note (a shield to the broadcaster's 0zk). When `grossUp` is set, `amount` is the
   * NET amount the relayer must receive and the SDK grosses it up for the on-chain shield fee (§4.6.1);
   * otherwise `amount` is the literal gross note value.
   */
  readonly feeShield: {
    readonly shieldedAddress: string;
    readonly amount: bigint;
    readonly tokenAddress: string;
    readonly grossUp?: ShieldFeeTiers;
  };
}

/**
 * Assemble a gasless shield: the two shield requests (user note + relayer fee note), their bound
 * `requestsHash`, and the EIP-712 typed data to sign. The caller signs `typedData` (the intent) and a
 * separate EIP-2612 permit, then submits `gaslessShield(params, intentSig, shieldRequests)` via the relayer.
 */
export async function buildGaslessShield(
  input: GaslessShieldInput,
  shieldPrivateKey: Uint8Array,
): Promise<{ shieldRequests: ShieldRequest[]; requestsHash: `0x${string}`; typedData: ShieldIntentTypedData }> {
  const userNote = await buildShieldRequest(input.userShield, shieldPrivateKey);
  // Gross up the fee note so the relayer nets `amount` AFTER the pool's shield fee (§4.6.1); if no tiers
  // are given, `amount` is used verbatim as the gross note value.
  const feeValue = input.feeShield.grossUp !== undefined
    ? grossUpShieldFee(input.feeShield.amount, input.feeShield.grossUp)
    : input.feeShield.amount;
  const feeNote = await buildShieldRequest(
    { shieldedAddress: input.feeShield.shieldedAddress, amount: feeValue, tokenAddress: input.feeShield.tokenAddress },
    shieldPrivateKey,
  );
  const shieldRequests = [userNote.shieldRequest, feeNote.shieldRequest];
  const requestsHash = hashShieldRequests(shieldRequests);
  const typedData = buildShieldIntentTypedData({
    wrapperAddress: input.wrapperAddress,
    chainId: input.chainId,
    intent: { user: input.user, requestsHash, integrator: input.integrator, deadline: input.deadline, nonce: input.nonce },
  });
  return { shieldRequests, requestsHash, typedData };
}

/** EIP-2612 permit message the user signs so the wrapper can pull USDC gaslessly (owner→spender allowance). */
export interface PermitMessage {
  readonly owner: `0x${string}`;
  readonly spender: `0x${string}`;
  readonly value: bigint;
  readonly nonce: bigint;
  readonly deadline: bigint;
}

export interface PermitTypedData {
  readonly domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  readonly types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  readonly message: PermitMessage;
}

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

/**
 * Build the EIP-2612 permit typed data for the gasless shield's token pull. The wrapper calls
 * `token.permit(owner, spender=wrapper, value=totalAmount, deadline, v,r,s)` then `transferFrom`, so the
 * user signs this permit in addition to the ShieldIntent. The domain is the TOKEN's own EIP-712 domain —
 * pass its `name`/`version` (e.g. USDC "USD Coin"/"2") and the `nonce` from `token.nonces(owner)`.
 * `value` must be the sum of all shield-note gross values (the wrapper pulls the total).
 */
export function buildPermitTypedData(params: {
  token: { address: `0x${string}`; name: string; version: string };
  chainId: number;
  owner: `0x${string}`;
  spender: `0x${string}`;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
}): PermitTypedData {
  return {
    domain: { name: params.token.name, version: params.token.version, chainId: params.chainId, verifyingContract: params.token.address },
    types: PERMIT_TYPES,
    message: { owner: params.owner, spender: params.spender, value: params.value, nonce: params.nonce, deadline: params.deadline },
  };
}

/** The EIP-712 digest the token verifies for an EIP-2612 permit. */
export function hashPermit(typedData: PermitTypedData): `0x${string}` {
  return TypedDataEncoder.hash(
    typedData.domain,
    typedData.types as Record<string, Array<{ name: string; type: string }>>,
    typedData.message,
  ) as `0x${string}`;
}
