// ABOUTME: Pool event decoder (SPEC §4.4) — formats decoded Shield/Transact/Nullified event args into
// ABOUTME: the typed commitment/ciphertext/nullifier structures that feed merkletree, note-crypto, balances.

import { TransactNote, getTokenDataHash, type TokenData } from '../core/index';
import type { CommitmentCiphertextV2 } from './note-crypto';
import type { SpentNullifier } from './balances';

/**
 * Human-readable ABI for the Railgun V2 pool events the SDK consumes. Provider-agnostic: a consumer
 * builds an ethers/viem Interface from these, parses raw logs, and passes the decoded args to the
 * formatters below (matching the ethers-free design of `fetchLogsRanged`).
 */
export const POOL_V2_EVENT_ABI = [
  'event Shield(uint256 treeNumber, uint256 startPosition, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value)[] commitments, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey)[] shieldCiphertext, uint256[] fees)',
  'event Transact(uint256 treeNumber, uint256 startPosition, bytes32[] hash, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] ciphertext)',
  'event Nullified(uint16 treeNumber, bytes32[] nullifier)',
] as const;

/** Per-log context the raw event args don't carry. */
export interface LogMeta {
  readonly blockNumber: number;
  readonly txid: string;
}

// --- decoded-arg input shapes (structurally compatible with an ethers v6 Result) ---

interface RawTokenData {
  readonly tokenType: bigint | number;
  readonly tokenAddress: string;
  readonly tokenSubID: bigint | number;
}
interface RawShieldCommitment {
  readonly npk: string;
  readonly token: RawTokenData;
  readonly value: bigint | number;
}
interface RawShieldCiphertext {
  readonly encryptedBundle: readonly string[]; // bytes32[3]
  readonly shieldKey: string;
}
export interface RawShieldArgs {
  readonly treeNumber: bigint | number;
  readonly startPosition: bigint | number;
  readonly commitments: readonly RawShieldCommitment[];
  readonly shieldCiphertext: readonly RawShieldCiphertext[];
  readonly fees: readonly (bigint | number)[];
}
interface RawCommitmentCiphertext {
  readonly ciphertext: readonly string[]; // bytes32[4]
  readonly blindedSenderViewingKey: string;
  readonly blindedReceiverViewingKey: string;
  readonly annotationData: string;
  readonly memo: string;
}
export interface RawTransactArgs {
  readonly treeNumber: bigint | number;
  readonly startPosition: bigint | number;
  readonly hash: readonly string[];
  readonly ciphertext: readonly RawCommitmentCiphertext[];
}
export interface RawNullifiedArgs {
  readonly treeNumber: bigint | number;
  readonly nullifier: readonly string[];
}

// --- decoded output shapes ---

/** A plaintext shield commitment (value/token are public; ownership is proven via shieldCiphertext). */
export interface DecodedShieldCommitment {
  readonly tree: number;
  readonly position: number;
  readonly blockNumber: number;
  readonly txid: string;
  readonly hash: string; // leaf commitment hash Poseidon(npk, tokenHash, value), no-0x
  readonly npk: string; // no-0x
  readonly tokenData: TokenData;
  readonly value: bigint;
  readonly encryptedBundle: readonly [string, string, string]; // no-0x
  readonly shieldKey: string; // no-0x
  readonly fee?: bigint;
}

/** A transact commitment: the leaf hash + the note ECIES ciphertext (feeds `tryDecryptCommitment`). */
export interface DecodedTransactCommitment {
  readonly tree: number;
  readonly position: number;
  readonly blockNumber: number;
  readonly txid: string;
  readonly hash: string; // leaf, no-0x
  readonly ciphertext: CommitmentCiphertextV2;
}

/** A spent-note marker, tree-scoped (feeds `computeBalances`). */
export interface DecodedNullifier extends SpentNullifier {
  readonly blockNumber: number;
  readonly txid: string;
}

export interface DecodedPoolEvents {
  readonly shields: DecodedShieldCommitment[];
  readonly transacts: DecodedTransactCommitment[];
  readonly nullifiers: DecodedNullifier[];
}

/** A parsed log ready to format: the event name + its decoded args + per-log context. */
export interface ParsedPoolLog extends LogMeta {
  readonly name: 'Shield' | 'Transact' | 'Nullified' | string;
  readonly args: RawShieldArgs | RawTransactArgs | RawNullifiedArgs;
}

// Browser-safe helpers (core does not re-export ByteUtils; keep this bundlable).
function strip0x(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}
function hexToBytes(hex: string): Uint8Array {
  const clean = strip0x(hex);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function nToHex256(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

/** Map an on-chain `CommitmentCiphertext` struct to the note-crypto `CommitmentCiphertextV2` shape. */
export function formatCommitmentCiphertext(raw: RawCommitmentCiphertext): CommitmentCiphertextV2 {
  return {
    // bytes32[4] = [ivTag, encodedMPK, random&amount, token] — exactly the packed form note-crypto expects.
    ciphertext: raw.ciphertext.map(strip0x),
    blindedSenderViewingKey: hexToBytes(raw.blindedSenderViewingKey),
    blindedReceiverViewingKey: hexToBytes(raw.blindedReceiverViewingKey),
    memo: raw.memo,
    annotationData: raw.annotationData,
  };
}

/** Format a Shield event into its per-commitment leaves. */
export function formatShieldEvent(args: RawShieldArgs, meta: LogMeta): DecodedShieldCommitment[] {
  const tree = Number(args.treeNumber);
  const start = Number(args.startPosition);
  return args.commitments.map((c, i): DecodedShieldCommitment => {
    // Lowercase the address to match the engine's serializeTokenData before hashing.
    const tokenData: TokenData = {
      tokenType: Number(c.token.tokenType),
      tokenAddress: String(c.token.tokenAddress).toLowerCase(),
      tokenSubID: BigInt(c.token.tokenSubID).toString(),
    };
    const npk = strip0x(c.npk);
    const value = BigInt(c.value);
    const tokenHash = getTokenDataHash(tokenData);
    const hash = nToHex256(TransactNote.getHash(BigInt(`0x${npk}`), tokenHash, value));
    const sc = args.shieldCiphertext[i]!;
    const feeRaw = args.fees?.[i];
    return {
      tree,
      position: start + i,
      blockNumber: meta.blockNumber,
      txid: meta.txid,
      hash,
      npk,
      tokenData,
      value,
      encryptedBundle: [strip0x(sc.encryptedBundle[0]!), strip0x(sc.encryptedBundle[1]!), strip0x(sc.encryptedBundle[2]!)],
      shieldKey: strip0x(sc.shieldKey),
      // Omit `fee` entirely when absent (exactOptionalPropertyTypes) rather than setting it undefined.
      ...(feeRaw === undefined ? {} : { fee: BigInt(feeRaw) }),
    };
  });
}

/** Format a Transact event into its per-commitment leaves + note ciphertexts. */
export function formatTransactEvent(args: RawTransactArgs, meta: LogMeta): DecodedTransactCommitment[] {
  const tree = Number(args.treeNumber);
  const start = Number(args.startPosition);
  return args.ciphertext.map((c, i): DecodedTransactCommitment => ({
    tree,
    position: start + i,
    blockNumber: meta.blockNumber,
    txid: meta.txid,
    hash: strip0x(args.hash[i]!),
    ciphertext: formatCommitmentCiphertext(c),
  }));
}

/** Format a Nullified event into tree-scoped spent markers. */
export function formatNullifiedEvent(args: RawNullifiedArgs, meta: LogMeta): DecodedNullifier[] {
  const tree = Number(args.treeNumber);
  return args.nullifier.map((n): DecodedNullifier => ({
    tree,
    nullifier: BigInt(n),
    blockNumber: meta.blockNumber,
    txid: meta.txid,
  }));
}

/** Dispatch a batch of parsed logs into the aggregated decoded-event set. Unknown names are ignored. */
export function decodePoolEvents(logs: readonly ParsedPoolLog[]): DecodedPoolEvents {
  const out: DecodedPoolEvents = { shields: [], transacts: [], nullifiers: [] };
  for (const log of logs) {
    const meta: LogMeta = { blockNumber: log.blockNumber, txid: log.txid };
    switch (log.name) {
      case 'Shield':
        out.shields.push(...formatShieldEvent(log.args as RawShieldArgs, meta));
        break;
      case 'Transact':
        out.transacts.push(...formatTransactEvent(log.args as RawTransactArgs, meta));
        break;
      case 'Nullified':
        out.nullifiers.push(...formatNullifiedEvent(log.args as RawNullifiedArgs, meta));
        break;
      default:
        break; // not a pool commitment/nullifier event
    }
  }
  return out;
}
