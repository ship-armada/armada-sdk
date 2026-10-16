// ABOUTME: SpendPlanner (F1, #143) — plans a wallet's spends over its spendable notes, the instance's verified trees and
// ABOUTME: the resolved config: transfers/unshields, the "Max" amounts, consolidations, and each plan's merkle proofs.

import { planSpend, type PlanTransferParams } from './plan';
import { planConsolidate, txosAfterConsolidation } from './consolidate';
import { maxTransferAmount, maxUnshieldAmount } from './max-transfer';
import { isCrossChainUnshield } from './preflight';
import { InvalidRequestError } from '../errors';
import type { Plan, PlanSelection } from './index';
import type { TXO } from '../sync/balances';
import type { TreeStore } from '../sync/tree-store';
import type { ResolvedConfig } from '../config';
import type { ConsolidateRequest, MaxTransferRequest, MaxUnshieldRequest, PlanTransferRequest } from '../wallet/index';

// Any EVM address: a plain unshield's max doesn't depend on where it goes, only on its value.
const MAX_UNSHIELD_PROBE_RECIPIENT = '0x0000000000000000000000000000000000000001' as const;

/**
 * Plans spends of `txos` — the wallet's spendable notes, holds excluded — against `tree`, the instance's verified
 * trees. Every method is synchronous, so the roots a plan binds and the merkle proofs it captures come from the same
 * trees, with no sync able to advance them in between (SPEC §4.6).
 */
export class SpendPlanner {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly tree: TreeStore,
  ) {}

  /**
   * A transfer or unshield as ONE OR MORE groups: a fragmented transfer yields >1 group, submitted atomically as one
   * transact([...]); each group is an independent Plan proved separately (the caller proves all, then combines the
   * calldata).
   */
  planTransfer(request: PlanTransferRequest, txos: readonly TXO[]): Plan[] {
    return this.withMerkleProofs(planSpend(this.spendParams(request, txos, this.rootsFor(txos))));
  }

  /**
   * Plan over the notes as they'd be once `consolidation` confirms (its merged notes in the current tree). Planning
   * only — the hypothetical notes can't be proved, so no merkle proofs are captured.
   */
  planTransferAfter(consolidation: readonly Plan[], request: PlanTransferRequest, txos: readonly TXO[]): PlanSelection[] {
    const currentTree = this.currentTree();
    const after = txosAfterConsolidation(txos, consolidation, currentTree);
    const roots = this.rootsFor(after);
    if (!roots.has(currentTree)) roots.set(currentTree, BigInt(`0x${this.tree.root(currentTree)}`));
    return planSpend(this.spendParams(request, after, roots));
  }

  /** The largest single-recipient transfer, fee included. */
  maxTransferAmount(request: MaxTransferRequest, txos: readonly TXO[]): bigint {
    // The planner request for a transfer (`transfer` fee tier); the max probes it with its own amounts.
    return maxTransferAmount(this.spendParams({ ...request, outputs: [] }, txos, this.rootsFor(txos)));
  }

  /** The largest unshield, fee included. */
  maxUnshieldAmount(request: MaxUnshieldRequest, txos: readonly TXO[]): bigint {
    // The planner request for this unshield (at the caller's per-proof fee); the max probes its value.
    const destination = request.unshield ?? { recipient: MAX_UNSHIELD_PROBE_RECIPIENT };
    const params = this.spendParams(
      {
        outputs: [],
        ...(request.fee !== undefined ? { fee: request.fee } : {}),
        ...(request.tokenAddress !== undefined ? { tokenAddress: request.tokenAddress } : {}),
        unshield: { ...destination, amount: 0n },
      },
      txos,
      this.rootsFor(txos),
    );
    return maxUnshieldAmount({ ...params, unshield: params.unshield! });
  }

  /** A consolidation (issue #98). Requires `pool.supportedShapes`, which sizes the merge groups. */
  consolidate(request: ConsolidateRequest, txos: readonly TXO[]): Plan[] {
    const supportedShapes = this.config.supportedShapes;
    if (supportedShapes === undefined) {
      throw new InvalidRequestError('consolidate: pool.supportedShapes is required (it sizes the merge groups)');
    }
    // A consolidation is a bare transact() self-spend, priced by the relayer at the `transfer` tier, PER
    // PROOF, always in USDC (the only token the relayer counts).
    const fee = request.fee;
    return this.withMerkleProofs(
      planConsolidate({
        txos,
        tokenAddress: request.tokenAddress ?? this.config.usdcAddress,
        ...(fee !== undefined && fee.perProof > 0n
          ? {
              fee: {
                broadcasterShieldedAddress: fee.broadcasterShieldedAddress,
                value: fee.perProof,
                tokenAddress: this.config.usdcAddress,
              },
            }
          : {}),
        roots: this.rootsFor(txos),
        currentTree: this.currentTree(),
        chainID: BigInt(this.config.chainId),
        supportedShapes,
      }),
    );
  }

  // The pool's current (latest) tree: the scan rebuilds every tree, so the highest one seen.
  private currentTree(): number {
    const trees = this.tree.treeNumbers();
    return trees.length === 0 ? 0 : Math.max(...trees);
  }

  // The current root of every tree the notes sit in, read from the same trees the proofs come from.
  private rootsFor(txos: readonly TXO[]): Map<number, bigint> {
    const roots = new Map<number, bigint>();
    for (const txo of txos) {
      if (!roots.has(txo.tree)) roots.set(txo.tree, BigInt(`0x${this.tree.root(txo.tree)}`));
    }
    return roots;
  }

  /**
   * Reject a cross-chain (CCTP) unshield the hub pool would revert (#134), before any proving. It is cross-chain
   * when it carries a CCTP binding, or commits `adaptParams` to anything but the yield adapter (the same test
   * preflight uses). It must then:
   *   - carry its decoded `adaptBinding`, so the planner can check `maxFee < value`;
   *   - spend USDC (CCTP bridges USDC only);
   *   - pay the pool (the final recipient is in the binding);
   *   - name no `adaptContract`.
   */
  private assertCrossChainUnshield(request: PlanTransferRequest): void {
    const unshield = request.unshield;
    if (unshield === undefined) return;
    const crossChain =
      unshield.adaptBinding !== undefined ||
      (unshield.adaptParams !== undefined &&
        isCrossChainUnshield(
          { adaptContract: unshield.adaptContract ?? `0x${'00'.repeat(20)}`, adaptParams: unshield.adaptParams },
          this.config.yieldAdapterAddress,
        ));
    if (!crossChain) return;
    if (unshield.adaptBinding === undefined) {
      throw new InvalidRequestError('cross-chain unshield: needs unshield.adaptBinding (the decoded CCTP destination matching adaptParams)');
    }
    if (unshield.adaptContract !== undefined && BigInt(unshield.adaptContract) !== 0n) {
      throw new InvalidRequestError('cross-chain unshield: must not name an adaptContract (the pool rejects it)');
    }
    if ((request.tokenAddress ?? this.config.usdcAddress).toLowerCase() !== this.config.usdcAddress.toLowerCase()) {
      throw new InvalidRequestError('cross-chain unshield: must spend USDC (CCTP bridges USDC only)');
    }
    if (unshield.recipient.toLowerCase() !== this.config.poolAddress.toLowerCase()) {
      throw new InvalidRequestError(
        'cross-chain unshield: must pay the pool (unshield.recipient is the pool address; the final recipient is in the CCTP binding)',
      );
    }
  }

  /**
   * An in-proof fee note is minted in the spent token, and the relayer only counts USDC (#115). So reject a fee on
   * any other token's spend rather than plan one the relayer refuses after proving. A yield redeem pays its fee
   * contract-side (omit `fee`); `consolidate` pays a non-USDC merge's fee from a separate USDC group.
   */
  private assertUsdcFee(request: PlanTransferRequest): void {
    if (request.fee === undefined || request.fee.perProof <= 0n) return;
    if ((request.tokenAddress ?? this.config.usdcAddress).toLowerCase() === this.config.usdcAddress.toLowerCase()) return;
    throw new InvalidRequestError(
      'a non-USDC spend can\'t carry an in-proof fee: the fee note is paid in the spent token and the relayer only ' +
        'counts USDC. A yield redeem pays its fee contract-side (omit `fee`); merge non-USDC notes with consolidate, ' +
        'which pays the fee from a separate USDC group.',
    );
  }

  // The planner request for a transfer/unshield over `txos`.
  private spendParams(request: PlanTransferRequest, txos: readonly TXO[], roots: ReadonlyMap<number, bigint>): PlanTransferParams {
    this.assertCrossChainUnshield(request);
    this.assertUsdcFee(request);
    // The caller's fee is PER PROOF: a split spend pays it once per group (planSpend scales it). No fee
    // (or zero) means no fee note.
    const fee = request.fee;
    return {
      txos,
      // Defaults to USDC; a caller can spend any pool token (e.g. yield vault shares on redeem).
      tokenAddress: request.tokenAddress ?? this.config.usdcAddress,
      outputs: request.outputs.map((o) => ({ toShieldedAddress: o.to0zk, value: o.amount, ...(o.memo !== undefined ? { memo: o.memo } : {}) })),
      ...(fee !== undefined && fee.perProof > 0n ? { fee: { broadcasterShieldedAddress: fee.broadcasterShieldedAddress, value: fee.perProof } } : {}),
      ...(request.unshield
        ? {
            unshield: {
              recipient: request.unshield.recipient,
              value: request.unshield.amount,
              ...(request.unshield.adaptParams ? { adaptParams: request.unshield.adaptParams } : {}),
              ...(request.unshield.adaptContract ? { adaptContract: request.unshield.adaptContract } : {}),
              ...(request.unshield.adaptBinding ? { adaptBinding: request.unshield.adaptBinding } : {}),
            },
          }
        : {}),
      roots,
      chainID: BigInt(this.config.chainId),
      ...(this.config.supportedShapes !== undefined ? { supportedShapes: this.config.supportedShapes } : {}),
      sweepNoteThreshold: this.config.sweepNoteThreshold,
    };
  }

  // Capture each selected input's merkle proof from the SAME trees the roots came from (no await since roots were
  // read), so each plan owns proofs consistent with its `merkleRoot`. `prove()` uses these rather than re-reading
  // live state, closing the plan→prove tree-append race (SPEC §4.6).
  private withMerkleProofs(selections: readonly PlanSelection[]): Plan[] {
    return selections.map((selection) => ({
      ...selection,
      merkleProofs: selection.selectedInputs.map((txo) =>
        this.tree.merkleProof(txo.tree, txo.position).elements.map((e) => BigInt(`0x${e}`)),
      ),
    }));
  }
}
