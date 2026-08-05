// ABOUTME: Native transact() calldata decoder (SPEC §4.6) — the verifier/relayer decode path that
// ABOUTME: replaces synthetic-calldata normalization. ABI-decodes transact(Transaction[]) into DecodedTransact[].

import { Interface } from 'ethers';
import { formatCommitmentCiphertext } from '../sync/index';
import type { DecodedTransact, DecodedBoundParams } from './index';

/** ABI of the pool `transact(Transaction[])` entry point (Railgun V2 struct layout). */
export const TRANSACT_ABI = [
  'function transact(' +
    '(' +
    '((uint256,uint256),(uint256[2],uint256[2]),(uint256,uint256)) proof,' +
    'bytes32 merkleRoot,' +
    'bytes32[] nullifiers,' +
    'bytes32[] commitments,' +
    '(uint16 treeNumber,uint72 minGasPrice,uint8 unshield,uint64 chainID,address adaptContract,bytes32 adaptParams,' +
    '(bytes32[4] ciphertext,bytes32 blindedSenderViewingKey,bytes32 blindedReceiverViewingKey,bytes annotationData,bytes memo)[] commitmentCiphertext' +
    ') boundParams,' +
    '(bytes32 npk,(uint8 tokenType,address tokenAddress,uint256 tokenSubID) token,uint120 value) unshieldPreimage' +
    ')[] _transactions' +
    ')',
] as const;

// UnshieldType.NONE — no unshield output on this transaction.
const UNSHIELD_NONE = 0;

const iface = new Interface(TRANSACT_ABI as unknown as string[]);

// The shape ethers decodes a Transaction tuple into (named Result access): uints → bigint, bytes/address → hex.
interface RawCiphertext {
  ciphertext: readonly string[];
  blindedSenderViewingKey: string;
  blindedReceiverViewingKey: string;
  annotationData: string;
  memo: string;
}
interface RawTx {
  merkleRoot: string;
  nullifiers: readonly string[];
  commitments: readonly string[];
  boundParams: {
    treeNumber: bigint;
    minGasPrice: bigint;
    unshield: bigint;
    chainID: bigint;
    adaptContract: string;
    adaptParams: string;
    commitmentCiphertext: readonly RawCiphertext[];
  };
  unshieldPreimage: { npk: string; token: { tokenAddress: string }; value: bigint };
}

// ethers returns struct fields as a Result; access by name and normalise hex → bigint / typed hex.
function decodeOne(tx: RawTx): DecodedTransact {
  const bp = tx.boundParams;

  const boundParams: DecodedBoundParams = {
    treeNumber: Number(bp.treeNumber),
    minGasPrice: BigInt(bp.minGasPrice),
    unshield: Number(bp.unshield),
    chainID: BigInt(bp.chainID),
    adaptContract: bp.adaptContract as `0x${string}`,
    adaptParams: bp.adaptParams as `0x${string}`,
    // decodedAdaptParams intentionally omitted here — adaptParams binding decode is a separate step.
  };

  const commitmentCiphertexts = bp.commitmentCiphertext.map((c) =>
    formatCommitmentCiphertext({
      ciphertext: c.ciphertext,
      blindedSenderViewingKey: c.blindedSenderViewingKey,
      blindedReceiverViewingKey: c.blindedReceiverViewingKey,
      annotationData: c.annotationData,
      memo: c.memo,
    }),
  );

  const base: DecodedTransact = {
    nullifiers: tx.nullifiers.map((n) => BigInt(n)),
    commitments: tx.commitments.map((c) => BigInt(c)),
    merkleRoot: BigInt(tx.merkleRoot),
    boundParams,
    commitmentCiphertexts,
  };

  if (Number(bp.unshield) === UNSHIELD_NONE) {
    return base;
  }
  const pre = tx.unshieldPreimage;
  return {
    ...base,
    unshieldPreimage: {
      npk: BigInt(pre.npk),
      tokenAddress: pre.token.tokenAddress as `0x${string}`,
      value: BigInt(pre.value),
    },
  };
}

/**
 * Decode a `transact(Transaction[])` calldata blob into one `DecodedTransact` per bundled transaction.
 * Pure/synchronous — the verifier feeds raw relay calldata and gets structured nullifiers, commitments,
 * bound params, and the output note ciphertexts (for in-band fee extraction).
 */
export function decodeTransact(calldata: string): DecodedTransact[] {
  const [transactions] = iface.decodeFunctionData('transact', calldata) as unknown as [RawTx[]];
  return transactions.map(decodeOne);
}
