// ABOUTME: Native quick-sync wire contract (SPEC §4.4) — the JSON-safe schema an indexer serves and
// ABOUTME: IndexerEventSource consumes. The canonical shape both the watcher and the SDK agree on.

import type {
  DecodedPoolEvents,
  DecodedShieldCommitment,
  DecodedTransactCommitment,
  DecodedNullifier,
  DecodedUnshield,
} from './event-decoder';
import type { CommitmentCiphertextV2 } from './note-crypto';
import { QuickSyncSchemaError } from '../errors';

/**
 * Bumped on any breaking change to the wire shapes below. The watcher stamps it into every response;
 * `parseQuickSync` rejects anything it doesn't recognize, so a producer/consumer skew fails loudly
 * rather than silently mis-scanning.
 */
export const QUICK_SYNC_SCHEMA_VERSION = 1;

// ── Wire shapes: a JSON-safe projection of DecodedPoolEvents ─────────────────
// The scanner's native types carry `bigint` (value/fee/nullifier) and `Uint8Array` (blinded keys),
// neither JSON-serializable. On the wire those become decimal strings and bare hex; everything else
// is already a string/number and passes through unchanged.

export interface WireTokenData {
  readonly tokenType: number;
  readonly tokenAddress: string;
  readonly tokenSubID: string;
}

export interface WireShieldCommitment {
  readonly tree: number;
  readonly position: number;
  readonly blockNumber: number;
  readonly txid: string;
  readonly hash: string;
  readonly npk: string;
  readonly tokenData: WireTokenData;
  readonly value: string; // bigint → decimal string
  readonly encryptedBundle: readonly [string, string, string];
  readonly shieldKey: string;
  readonly fee?: string; // bigint → decimal string; omitted when the on-chain event had no fee
}

export interface WireCommitmentCiphertext {
  readonly ciphertext: readonly string[];
  readonly blindedSenderViewingKey: string; // hex, no-0x
  readonly blindedReceiverViewingKey: string; // hex, no-0x
  readonly memo: string;
  readonly annotationData: string;
}

export interface WireTransactCommitment {
  readonly tree: number;
  readonly position: number;
  readonly blockNumber: number;
  readonly txid: string;
  readonly hash: string;
  readonly ciphertext: WireCommitmentCiphertext;
}

export interface WireNullifier {
  readonly tree: number;
  readonly nullifier: string; // bigint → decimal string
  readonly blockNumber: number;
  readonly txid: string;
}

export interface WireUnshield {
  readonly to: string;
  readonly tokenData: WireTokenData;
  readonly amount: string; // bigint → decimal string
  readonly fee: string; // bigint → decimal string
  readonly blockNumber: number;
  readonly txid: string;
}

/**
 * The full quick-sync response envelope. `syncedThroughBlock` is the highest block the indexer has
 * fully covered — it may lag the requested range's head, in which case the SDK RPC-covers the tail.
 */
export interface QuickSyncResponse {
  readonly schemaVersion: number;
  readonly syncedThroughBlock: number;
  readonly shields: readonly WireShieldCommitment[];
  readonly transacts: readonly WireTransactCommitment[];
  readonly nullifiers: readonly WireNullifier[];
  readonly unshields: readonly WireUnshield[];
}

// ── Serialize (producer side; also used by tests + any SDK-side indexer) ─────

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function serializeQuickSync(
  events: DecodedPoolEvents,
  syncedThroughBlock: number,
): QuickSyncResponse {
  return {
    schemaVersion: QUICK_SYNC_SCHEMA_VERSION,
    syncedThroughBlock,
    shields: events.shields.map((s) => ({
      tree: s.tree,
      position: s.position,
      blockNumber: s.blockNumber,
      txid: s.txid,
      hash: s.hash,
      npk: s.npk,
      tokenData: {
        tokenType: s.tokenData.tokenType,
        tokenAddress: s.tokenData.tokenAddress,
        tokenSubID: s.tokenData.tokenSubID,
      },
      value: s.value.toString(),
      encryptedBundle: [s.encryptedBundle[0], s.encryptedBundle[1], s.encryptedBundle[2]],
      shieldKey: s.shieldKey,
      ...(s.fee === undefined ? {} : { fee: s.fee.toString() }),
    })),
    transacts: events.transacts.map((t) => ({
      tree: t.tree,
      position: t.position,
      blockNumber: t.blockNumber,
      txid: t.txid,
      hash: t.hash,
      ciphertext: {
        ciphertext: [...t.ciphertext.ciphertext],
        blindedSenderViewingKey: bytesToHex(t.ciphertext.blindedSenderViewingKey),
        blindedReceiverViewingKey: bytesToHex(t.ciphertext.blindedReceiverViewingKey),
        memo: t.ciphertext.memo,
        annotationData: t.ciphertext.annotationData,
      },
    })),
    nullifiers: events.nullifiers.map((n) => ({
      tree: n.tree,
      nullifier: n.nullifier.toString(),
      blockNumber: n.blockNumber,
      txid: n.txid,
    })),
    unshields: events.unshields.map((u) => ({
      to: u.to,
      tokenData: {
        tokenType: u.tokenData.tokenType,
        tokenAddress: u.tokenData.tokenAddress,
        tokenSubID: u.tokenData.tokenSubID,
      },
      amount: u.amount.toString(),
      fee: u.fee.toString(),
      blockNumber: u.blockNumber,
      txid: u.txid,
    })),
  };
}

// ── Parse + validate (consumer side; a trust boundary — the watcher is external) ─

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function str(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new QuickSyncSchemaError(`quick-sync: ${field} must be a string`);
  return v;
}
// Every numeric field in the wire format is a non-negative integer (tree/position/block/tokenType).
// An indexer is untrusted, so reject negatives, fractions, NaN/Infinity, and (with `max`) out-of-range
// values — a `position` past the tree size or a negative block would otherwise poison the scan state.
const LEAVES_PER_TREE = 65536;
function num(v: unknown, field: string, max?: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0)
    throw new QuickSyncSchemaError(`quick-sync: ${field} must be a non-negative integer`);
  if (max !== undefined && v > max)
    throw new QuickSyncSchemaError(`quick-sync: ${field} must be <= ${max}`);
  return v;
}
function big(v: unknown, field: string): bigint {
  if (typeof v !== 'string') throw new QuickSyncSchemaError(`quick-sync: ${field} must be a decimal string`);
  let parsed: bigint;
  try {
    parsed = BigInt(v);
  } catch {
    throw new QuickSyncSchemaError(`quick-sync: ${field} is not a valid integer ("${v}")`);
  }
  // value/fee/amount/nullifier are all non-negative field elements — a negative is malformed.
  if (parsed < 0n) throw new QuickSyncSchemaError(`quick-sync: ${field} must be non-negative`);
  return parsed;
}
function hexToBytes(hex: string, field: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean))
    throw new QuickSyncSchemaError(`quick-sync: ${field} is not valid hex`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function tuple3(v: unknown, field: string): [string, string, string] {
  if (!Array.isArray(v) || v.length !== 3)
    throw new QuickSyncSchemaError(`quick-sync: ${field} must be a 3-tuple`);
  return [str(v[0], `${field}[0]`), str(v[1], `${field}[1]`), str(v[2], `${field}[2]`)];
}

function parseShield(v: unknown, i: number): DecodedShieldCommitment {
  if (!isObject(v)) throw new QuickSyncSchemaError(`quick-sync: shields[${i}] must be an object`);
  const td = v.tokenData;
  if (!isObject(td)) throw new QuickSyncSchemaError(`quick-sync: shields[${i}].tokenData must be an object`);
  return {
    tree: num(v.tree, `shields[${i}].tree`),
    position: num(v.position, `shields[${i}].position`, LEAVES_PER_TREE - 1),
    blockNumber: num(v.blockNumber, `shields[${i}].blockNumber`),
    txid: str(v.txid, `shields[${i}].txid`),
    hash: str(v.hash, `shields[${i}].hash`),
    npk: str(v.npk, `shields[${i}].npk`),
    tokenData: {
      tokenType: num(td.tokenType, `shields[${i}].tokenData.tokenType`),
      tokenAddress: str(td.tokenAddress, `shields[${i}].tokenData.tokenAddress`),
      tokenSubID: str(td.tokenSubID, `shields[${i}].tokenData.tokenSubID`),
    },
    value: big(v.value, `shields[${i}].value`),
    encryptedBundle: tuple3(v.encryptedBundle, `shields[${i}].encryptedBundle`),
    shieldKey: str(v.shieldKey, `shields[${i}].shieldKey`),
    ...(v.fee === undefined ? {} : { fee: big(v.fee, `shields[${i}].fee`) }),
  };
}

function parseTransact(v: unknown, i: number): DecodedTransactCommitment {
  if (!isObject(v)) throw new QuickSyncSchemaError(`quick-sync: transacts[${i}] must be an object`);
  const c = v.ciphertext;
  if (!isObject(c)) throw new QuickSyncSchemaError(`quick-sync: transacts[${i}].ciphertext must be an object`);
  // The on-chain V2 envelope is exactly [ivTag, data0, data1, data2]; a wrong arity would otherwise
  // blow up later in unpackCiphertext with a generic error instead of a typed schema rejection.
  if (!Array.isArray(c.ciphertext) || c.ciphertext.length !== 4)
    throw new QuickSyncSchemaError(`quick-sync: transacts[${i}].ciphertext.ciphertext must be a 4-element array`);
  const ciphertext: CommitmentCiphertextV2 = {
    ciphertext: c.ciphertext.map((x, j) => str(x, `transacts[${i}].ciphertext.ciphertext[${j}]`)),
    blindedSenderViewingKey: hexToBytes(
      str(c.blindedSenderViewingKey, `transacts[${i}].ciphertext.blindedSenderViewingKey`),
      `transacts[${i}].ciphertext.blindedSenderViewingKey`,
    ),
    blindedReceiverViewingKey: hexToBytes(
      str(c.blindedReceiverViewingKey, `transacts[${i}].ciphertext.blindedReceiverViewingKey`),
      `transacts[${i}].ciphertext.blindedReceiverViewingKey`,
    ),
    memo: str(c.memo, `transacts[${i}].ciphertext.memo`),
    annotationData: str(c.annotationData, `transacts[${i}].ciphertext.annotationData`),
  };
  return {
    tree: num(v.tree, `transacts[${i}].tree`),
    position: num(v.position, `transacts[${i}].position`, LEAVES_PER_TREE - 1),
    blockNumber: num(v.blockNumber, `transacts[${i}].blockNumber`),
    txid: str(v.txid, `transacts[${i}].txid`),
    hash: str(v.hash, `transacts[${i}].hash`),
    ciphertext,
  };
}

function parseNullifier(v: unknown, i: number): DecodedNullifier {
  if (!isObject(v)) throw new QuickSyncSchemaError(`quick-sync: nullifiers[${i}] must be an object`);
  return {
    tree: num(v.tree, `nullifiers[${i}].tree`),
    nullifier: big(v.nullifier, `nullifiers[${i}].nullifier`),
    blockNumber: num(v.blockNumber, `nullifiers[${i}].blockNumber`),
    txid: str(v.txid, `nullifiers[${i}].txid`),
  };
}

function parseUnshield(v: unknown, i: number): DecodedUnshield {
  if (!isObject(v)) throw new QuickSyncSchemaError(`quick-sync: unshields[${i}] must be an object`);
  const td = v.tokenData;
  if (!isObject(td)) throw new QuickSyncSchemaError(`quick-sync: unshields[${i}].tokenData must be an object`);
  return {
    to: str(v.to, `unshields[${i}].to`),
    tokenData: {
      tokenType: num(td.tokenType, `unshields[${i}].tokenData.tokenType`),
      tokenAddress: str(td.tokenAddress, `unshields[${i}].tokenData.tokenAddress`),
      tokenSubID: str(td.tokenSubID, `unshields[${i}].tokenData.tokenSubID`),
    },
    amount: big(v.amount, `unshields[${i}].amount`),
    fee: big(v.fee, `unshields[${i}].fee`),
    blockNumber: num(v.blockNumber, `unshields[${i}].blockNumber`),
    txid: str(v.txid, `unshields[${i}].txid`),
  };
}

/**
 * Validate + decode a quick-sync response into the scanner's native `DecodedPoolEvents` plus the
 * indexer's `syncedThroughBlock`. Throws `QuickSyncSchemaError` (code `QUICK_SYNC_SCHEMA`) on any
 * version/shape/type violation — the SDK then falls back to an RPC scan rather than trusting garbage.
 */
export function parseQuickSync(raw: unknown): {
  events: DecodedPoolEvents;
  syncedThroughBlock: number;
} {
  if (!isObject(raw)) throw new QuickSyncSchemaError('quick-sync: response is not an object');
  if (raw.schemaVersion !== QUICK_SYNC_SCHEMA_VERSION)
    throw new QuickSyncSchemaError(
      `quick-sync: unsupported schemaVersion ${String(raw.schemaVersion)} (expected ${QUICK_SYNC_SCHEMA_VERSION})`,
    );
  const syncedThroughBlock = num(raw.syncedThroughBlock, 'syncedThroughBlock');
  if (
    !Array.isArray(raw.shields) ||
    !Array.isArray(raw.transacts) ||
    !Array.isArray(raw.nullifiers) ||
    !Array.isArray(raw.unshields)
  )
    throw new QuickSyncSchemaError('quick-sync: shields/transacts/nullifiers/unshields must be arrays');
  return {
    events: {
      shields: raw.shields.map(parseShield),
      transacts: raw.transacts.map(parseTransact),
      nullifiers: raw.nullifiers.map(parseNullifier),
      unshields: raw.unshields.map(parseUnshield),
    },
    syncedThroughBlock,
  };
}
