// ABOUTME: go-nitro state-channel primitives (ADR-0020 H7) — channel id, state hash and ECDSA signer
// ABOUTME: recovery, byte-identical to armada-nitro/src/nitro/libraries/NitroUtils.sol. Parity-tested.

import { AbiCoder, keccak256, getBytes, verifyMessage, getAddress } from 'ethers';
import type { NitroSignature } from './chain-source';

/** One allocation of a go-nitro outcome (`ExitFormat.Allocation`). */
export interface NitroAllocation {
  /** `bytes32` destination; for a participant it is the address, left-padded to 32 bytes. */
  readonly destination: string;
  /** The allocation amount, decimal string or bigint. */
  readonly amount: string | bigint;
  /** `ExitFormat.AllocationType` (0 simple, 2 guarantee, …). */
  readonly allocationType: number;
  /** Extra metadata bytes, 0x-prefixed; `0x` when none. */
  readonly metadata: string;
}

/** The asset metadata of a single-asset exit (`ExitFormat.AssetMetadata`). */
export interface NitroAssetMetadata {
  /** `ExitFormat.AssetType` (0 Default, 1 ERC721, 2 ERC1155, 3 Qualified). */
  readonly assetType: number;
  readonly metadata: string;
}

/** One asset's exit of a go-nitro outcome (`ExitFormat.SingleAssetExit`). */
export interface NitroSingleAssetExit {
  readonly asset: string;
  readonly assetMetadata: NitroAssetMetadata;
  readonly allocations: readonly NitroAllocation[];
}

/** The part of a channel state that never changes (`INitroTypes.FixedPart`). */
export interface NitroFixedPart {
  readonly participants: readonly string[];
  readonly channelNonce: string | bigint | number;
  readonly appDefinition: string;
  readonly challengeDuration: number;
}

/** The part of a channel state that changes turn to turn (`INitroTypes.VariablePart`). */
export interface NitroVariablePart {
  readonly outcome: readonly NitroSingleAssetExit[];
  readonly appData: string;
  readonly turnNum: number;
  readonly isFinal: boolean;
}

// The ABI type of `Outcome.SingleAssetExit[]`, used to encode the outcome inside the state hash.
const OUTCOME_ABI_TYPE =
  'tuple(address asset, tuple(uint8 assetType, bytes metadata) assetMetadata, tuple(bytes32 destination, uint256 amount, uint8 allocationType, bytes metadata)[] allocations)[]';

// Encode an outcome array to the positional tuple form ethers' AbiCoder expects.
function outcomeValue(outcome: readonly NitroSingleAssetExit[]): unknown[] {
  return outcome.map((e) => [
    e.asset,
    [e.assetMetadata.assetType, e.assetMetadata.metadata],
    e.allocations.map((a) => [a.destination, BigInt(a.amount), a.allocationType, a.metadata]),
  ]);
}

/**
 * The channel id, `keccak256(abi.encode(participants, channelNonce, appDefinition, challengeDuration))`
 * (`NitroUtils.getChannelId`).
 */
export function getChannelId(fixedPart: NitroFixedPart): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ['address[]', 'uint64', 'address', 'uint48'],
      [
        fixedPart.participants.map((p) => getAddress(p)),
        BigInt(fixedPart.channelNonce),
        getAddress(fixedPart.appDefinition),
        fixedPart.challengeDuration,
      ],
    ),
  );
}

/**
 * The state hash, `keccak256(abi.encode(channelId, appData, outcome, turnNum, isFinal))`
 * (`NitroUtils.hashState`).
 */
export function hashNitroState(channelId: string, variablePart: NitroVariablePart): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes', OUTCOME_ABI_TYPE, 'uint48', 'bool'],
      [
        channelId,
        variablePart.appData,
        outcomeValue(variablePart.outcome),
        variablePart.turnNum,
        variablePart.isFinal,
      ],
    ),
  );
}

/**
 * Recover the ECDSA signer of a state hash. go-nitro signs the EIP-191 prefixed hash
 * (`NitroUtils.recoverSigner` over `prefixedHash(stateHash)`); `verifyMessage` of the 32 raw state-hash
 * bytes applies exactly that prefix.
 */
export function recoverNitroSigner(stateHash: string, signature: NitroSignature): string {
  return verifyMessage(getBytes(stateHash), { r: signature.r, s: signature.s, v: signature.v });
}

/** The go-nitro `bytes32` destination for a participant address: the address left-padded to 32 bytes. */
export function participantDestination(address: string): string {
  return `0x${getAddress(address).slice(2).toLowerCase().padStart(64, '0')}`;
}
