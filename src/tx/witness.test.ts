// ABOUTME: Structural tests for buildWitness (§4.6) — validates the computable invariants: nullifiers,
// ABOUTME: commitments, fee-first output ciphertexts, and the EdDSA spend-auth signature over the digest.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  initPoseidonPromise, poseidon, verifyEDDSA, TransactNote,
  getTokenDataERC20, getTokenDataHash,
} from '../core/index';
import { deriveKeyset, type Keyset } from '../wallet/derive';
import { LocalSigner } from '../wallet/local-signer';
import { UTXOMerkletree } from '../sync/merkletree';
import { createTransferNote, tryDecryptCommitment } from '../sync/index';
import { buildWitness, computeSpendIntentDigest, type WitnessInput, type WitnessSenderContext } from './witness';
import type { SpendSigner, SpendSignRequest, EddsaSignature } from '../wallet/index';
import type { PlanSummary, CctpBinding } from './index';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as const;
const nToHex = (n: bigint): string => n.toString(16).padStart(64, '0');

describe('buildWitness (§4.6)', () => {
  let sender: Keyset;
  let recipient: Keyset;
  let broadcaster: Keyset;
  let signer: LocalSigner;
  let tokenData: ReturnType<typeof getTokenDataERC20>;

  beforeAll(async () => {
    await initPoseidonPromise;
    sender = await deriveKeyset(new Uint8Array(32).fill(0x11));
    recipient = await deriveKeyset(new Uint8Array(32).fill(0x22));
    broadcaster = await deriveKeyset(new Uint8Array(32).fill(0x33));
    signer = await LocalSigner.fromRootSecret(new Uint8Array(32).fill(0x11));
    tokenData = getTokenDataERC20(USDC);
  });

  // A spendable input note owned by the sender, inserted into a fresh tree at position 0.
  async function makeInput(value: bigint): Promise<{ input: WitnessInput; merkleRoot: bigint }> {
    const note = createTransferNote({
      receiverAddressData: { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey },
      senderAddressData: { masterPublicKey: sender.masterPublicKey, viewingPublicKey: sender.viewingPublicKey },
      value, tokenData,
    });
    const tree = new UTXOMerkletree();
    tree.insert(nToHex(note.hash));
    const proof = tree.merkleProof(0);
    return {
      input: { random: note.random, value, position: 0, merkleProofElements: proof.elements.map((e) => BigInt(`0x${e.startsWith('0x') ? e.slice(2) : e}`)) },
      merkleRoot: BigInt(`0x${tree.root()}`),
    };
  }

  const senderCtx = (): WitnessSenderContext => ({
    masterPublicKey: sender.masterPublicKey,
    viewingPublicKey: sender.viewingPublicKey,
    viewingPrivateKey: sender.viewingPrivateKey,
    nullifyingKey: sender.nullifyingKey,
    spendingPublicKey: sender.spendingPublicKey,
    senderAddress: sender.shieldedAddress,
  });
  const summary: PlanSummary = { tokenAddress: USDC, inputTotal: 10n, outputs: [], changeValue: 0n };

  it('assembles a valid witness: nullifiers, commitments, fee-first ciphertexts, verified signature', async () => {
    const { input, merkleRoot } = await makeInput(10n);
    const built = await buildWitness({
      inputs: [input],
      // Fee-first ordering (Spike 2): broadcaster fee, then recipient, then change back to sender.
      outputs: [
        { receiverAddress: broadcaster.shieldedAddress, value: 1n },
        { receiverAddress: recipient.shieldedAddress, value: 6n },
        { receiverAddress: sender.shieldedAddress, value: 3n },
      ],
      tokenAddress: USDC, sender: senderCtx(), signer, summary,
      merkleRoot, treeNumber: 0, chainType: 0, chainId: 31337,
    });

    // Shape + nullifier.
    expect(built.shape).toEqual({ nullifiers: 1, commitments: 3 });
    expect(built.publicInputs.nullifiers).toEqual([TransactNote.getNullifier(sender.nullifyingKey, 0)]);
    expect(built.publicInputs.commitmentsOut).toHaveLength(3);

    // Formatted circuit inputs have the right shapes.
    const fi = built.formattedInputs;
    expect(fi.randomIn).toHaveLength(1);
    expect(fi.valueIn).toEqual([10n]);
    expect(fi.npkOut).toHaveLength(3);
    expect(fi.valueOut).toEqual([1n, 6n, 3n]); // fee, recipient, change — in order
    expect(fi.signature).toHaveLength(3);
    expect(fi.token).toBe(BigInt(`0x${getTokenDataHash(tokenData)}`));
    expect(fi.pathElements.length).toBeGreaterThan(0);

    // The spend-auth signature must verify against the digest and the sender's spending public key.
    const message = poseidon([built.publicInputs.merkleRoot, built.publicInputs.boundParamsHash, ...built.publicInputs.nullifiers, ...built.publicInputs.commitmentsOut]);
    const ok = verifyEDDSA(message, { R8: [fi.signature[0], fi.signature[1]], S: fi.signature[2] }, sender.spendingPublicKey);
    expect(ok).toBe(true);
  });

  it('hands the signer a context from which it can recompute the signed digest (M2, SPEC §4.2.1)', async () => {
    // WHY: a policy/external signer must be able to verify that `message` corresponds to the
    // human-inspectable context it approved — otherwise a compromised host could pair a benign context
    // with a malicious digest. computeSpendIntentDigest(context) === message closes that gap.
    const captured: SpendSignRequest[] = [];
    const capturingSigner: SpendSigner = {
      getSpendingPublicKey: () => signer.getSpendingPublicKey(),
      signBatch: async (reqs): Promise<EddsaSignature[]> => { captured.push(...reqs); return signer.signBatch(reqs); },
    };
    const { input, merkleRoot } = await makeInput(10n);
    const cctp: CctpBinding = { kind: 'cctp', recipient: `0x${'ab'.repeat(20)}`, destDomain: 3, maxFee: 500n };
    const built = await buildWitness({
      inputs: [input],
      outputs: [{ receiverAddress: broadcaster.shieldedAddress, value: 1n }],
      tokenAddress: USDC, sender: senderCtx(), signer: capturingSigner, summary,
      merkleRoot, treeNumber: 0, chainType: 0, chainId: 31337,
      unshield: 1, unshieldOutput: { recipient: `0x${'ab'.repeat(20)}`, value: 9n },
      adaptContract: `0x${'cd'.repeat(20)}`, adaptParams: `0x${'ab'.repeat(32)}`, decodedAdaptParams: cctp,
    });

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    // The signer can recompute the digest it signed purely from the context it was shown.
    expect(computeSpendIntentDigest(req.context)).toBe(req.message);
    // And that digest is exactly what the witness proves against.
    expect(req.message).toBe(
      poseidon([built.publicInputs.merkleRoot, built.publicInputs.boundParamsHash, ...built.publicInputs.nullifiers, ...built.publicInputs.commitmentsOut]),
    );
    // The decoded cross-chain destination is inspectable in the context (not just the one-way keccak).
    expect(req.context.boundParams.decodedAdaptParams).toEqual(cctp);
  });

  it('appends the unshield as the LAST commitment — npk = recipient, no ciphertext (public output)', async () => {
    // WHY: the engine pushes UnshieldNoteERC20 (npk=recipient) as the last output and its hash is the
    // last commitmentsOut; it has no commitmentCiphertext (it's public). A wrong npk / an extra
    // ciphertext / wrong ordering makes the proof revert on-chain — pin all three deterministically.
    const { input, merkleRoot } = await makeInput(10n);
    const recipient = '0x1111111111111111111111111111111111111111' as const;
    const built = await buildWitness({
      inputs: [input],
      outputs: [{ receiverAddress: broadcaster.shieldedAddress, value: 1n }], // shielded fee only
      tokenAddress: USDC, sender: senderCtx(), signer, summary,
      merkleRoot, treeNumber: 0, chainType: 0, chainId: 31337,
      unshield: 1,
      unshieldOutput: { recipient, value: 5n },
    });
    const fi = built.formattedInputs;
    // fee (shielded) + unshield (public) = 2 commitments; unshield is LAST.
    expect(built.shape.commitments).toBe(2);
    expect(built.publicInputs.commitmentsOut).toHaveLength(2);
    expect(fi.npkOut).toHaveLength(2);
    expect(fi.npkOut[fi.npkOut.length - 1]).toBe(BigInt(recipient)); // unshield npk = recipient address
    expect(fi.valueOut).toEqual([1n, 5n]); // fee, unshield
    // Ciphertexts cover ONLY the internal (shielded) output — the unshield carries none.
    expect(built.boundParams.commitmentCiphertext).toHaveLength(1);
    expect(built.boundParams.unshield).toBe(1);
  });

  it('fee note (first output) decrypts to the broadcaster; recipient note to the recipient', async () => {
    const { input, merkleRoot } = await makeInput(10n);
    const built = await buildWitness({
      inputs: [input],
      outputs: [
        { receiverAddress: broadcaster.shieldedAddress, value: 1n },
        { receiverAddress: recipient.shieldedAddress, value: 6n },
        { receiverAddress: sender.shieldedAddress, value: 3n },
      ],
      tokenAddress: USDC, sender: senderCtx(), signer, summary,
      merkleRoot, treeNumber: 0, chainType: 0, chainId: 31337,
    });

    const getter = { getTokenDataFromHash: async () => tokenData };
    const feeNote = await tryDecryptCommitment(
      built.boundParams.commitmentCiphertext[0]!,
      { addressData: { masterPublicKey: broadcaster.masterPublicKey, viewingPublicKey: broadcaster.viewingPublicKey }, viewingPrivateKey: broadcaster.viewingPrivateKey },
      getter,
    );
    expect(feeNote?.value).toBe(1n); // broadcaster fee is the FIRST output

    const recvNote = await tryDecryptCommitment(
      built.boundParams.commitmentCiphertext[1]!,
      { addressData: { masterPublicKey: recipient.masterPublicKey, viewingPublicKey: recipient.viewingPublicKey }, viewingPrivateKey: recipient.viewingPrivateKey },
      getter,
    );
    expect(recvNote?.value).toBe(6n);
  });

  it('produces a bound-params hash reduced into the SNARK field', async () => {
    const { input, merkleRoot } = await makeInput(5n);
    const built = await buildWitness({
      inputs: [input],
      outputs: [{ receiverAddress: recipient.shieldedAddress, value: 5n }],
      tokenAddress: USDC, sender: senderCtx(), signer, summary,
      merkleRoot, treeNumber: 0, chainType: 0, chainId: 31337,
    });
    const SNARK_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    expect(built.publicInputs.boundParamsHash).toBeLessThan(SNARK_PRIME);
    expect(built.publicInputs.boundParamsHash).toBeGreaterThan(0n);
  });
});
