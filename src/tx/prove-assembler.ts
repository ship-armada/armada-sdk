// ABOUTME: Prove assembly (F1, #143) — turns a planned spend into prove() inputs: the captured witness inputs, the
// ABOUTME: outputs in fee → recipients → change order (each tagged with its OutputType), and the bound params.

import { ChainType, OutputType } from '../core/index';
import { encodeSelfMetadata } from '../sync/index';
import { planWitnessInputs } from './plan';
import type { ProveParams } from './prove';
import type { WitnessOutputRequest } from './witness';
import type { Plan } from './index';
import type { ArtifactSource, ProveOptions, ProverAdapter } from '../prover/index';
import type { ResolvedConfig } from '../config';
import type { Keyset } from '../wallet/derive';
import type { SpendSigner } from '../wallet/index';

/** The wallet keys a spend witness needs: everything but the spending private key, which only the signer holds. */
export type SenderKeys = Omit<Keyset, 'spendingPrivateKey'>;

/**
 * The prove() inputs for one plan: its captured witness inputs, fee-first outputs, and the bound params, for the
 * wallet with `keys`, signed by `signer`, proved with `adapters`.
 */
export function proveParamsFor(
  plan: Plan,
  keys: SenderKeys,
  signer: SpendSigner,
  config: ResolvedConfig,
  adapters: { readonly artifacts: ArtifactSource; readonly prover: ProverAdapter },
  options?: ProveOptions,
): ProveParams {
  // Use the proofs the plan captured at plan time (NOT a fresh scan-state read) so the path elements
  // match `plan.merkleRoot` even if a sync advanced the tree since planning (SPEC §4.6).
  const inputs = planWitnessInputs(plan);
  // Emit order (Spike 2): broadcaster fee note FIRST, then recipients, then change back to self. Each
  // output carries its OutputType so sender-side recovery can tell fee/recipient/change apart later.
  const outputs: WitnessOutputRequest[] = [];
  if (plan.summary.feeOutput) outputs.push({ receiverAddress: plan.summary.feeOutput.toShieldedAddress, value: plan.summary.feeOutput.value, outputType: OutputType.BroadcasterFee });
  for (const o of plan.summary.outputs) outputs.push({ receiverAddress: o.toShieldedAddress, value: o.value, outputType: OutputType.Transfer, ...(o.memo !== undefined ? { memo: o.memo } : {}) });
  if (plan.summary.changeValue > 0n) {
    // Optionally stash caller metadata in the change note's memo (issue #88 lever 3). The change note
    // is self-owned, so a fresh scan recovers this on history() even after local storage is cleared.
    const changeMemo = options?.selfMetadata !== undefined ? encodeSelfMetadata(options.selfMetadata) : undefined;
    outputs.push({
      receiverAddress: keys.shieldedAddress,
      value: plan.summary.changeValue,
      outputType: OutputType.Change,
      ...(changeMemo !== undefined ? { memo: changeMemo } : {}),
    });
  }

  return {
    witness: {
      inputs,
      outputs,
      // The spent token comes from the plan (defaults to USDC; e.g. yield-share token on redeem).
      tokenAddress: plan.summary.tokenAddress,
      sender: {
        masterPublicKey: keys.masterPublicKey,
        viewingPublicKey: keys.viewingPublicKey,
        viewingPrivateKey: keys.viewingPrivateKey,
        nullifyingKey: keys.nullifyingKey,
        spendingPublicKey: keys.spendingPublicKey,
        senderAddress: keys.shieldedAddress,
      },
      signer,
      summary: plan.summary,
      merkleRoot: plan.merkleRoot,
      treeNumber: plan.boundParams.treeNumber,
      chainType: ChainType.EVM,
      chainId: config.chainId,
      unshield: plan.boundParams.unshield,
      // adaptContract/adaptParams are SNARK public inputs (bound-params hash + spend signature);
      // pass the plan's values so a cross-chain unshield's CCTP binding is committed by the proof.
      adaptContract: plan.boundParams.adaptContract,
      adaptParams: plan.boundParams.adaptParams,
      // Decoded CCTP binding (inspection-only) so the signer sees the destination it authorizes (§4.2.1).
      ...(plan.boundParams.decodedAdaptParams ? { decodedAdaptParams: plan.boundParams.decodedAdaptParams } : {}),
      ...(plan.summary.unshield ? { unshieldOutput: plan.summary.unshield } : {}),
    },
    artifacts: adapters.artifacts,
    prover: adapters.prover,
    poolAddress: config.poolAddress,
    ...(options?.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
    // The public unshield preimage the contract pays out on (npk = recipient EVM address).
    ...(plan.summary.unshield
      ? {
          unshieldPreimage: {
            npk: BigInt(plan.summary.unshield.recipient),
            tokenType: 0,
            tokenAddress: plan.summary.tokenAddress,
            tokenSubID: 0n,
            value: plan.summary.unshield.value,
          },
        }
      : {}),
  };
}
