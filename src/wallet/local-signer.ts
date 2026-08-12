// ABOUTME: LocalSigner (SPEC §4.2.1) — the default SpendSigner, holding the spending private key
// ABOUTME: derived from a rootSecret. Signs each intent digest with BabyJubjub EdDSA via core.

import { signEDDSA } from '../core/index';
import { deriveKeyset } from './derive';
import { InvalidRequestError } from '../errors';
import type { SpendSigner, SpendSignRequest, EddsaSignature } from './index';

/**
 * In-process signer derived from the wallet's rootSecret. It receives the entire batch of
 * fully-bound intents and signs each `message` (the pinned poseidon digest). This is everything the
 * repo does today; `ExternalSigner`/`ThresholdSigner` are drop-in swaps behind the same interface.
 */
export class LocalSigner implements SpendSigner {
  private disposed = false;

  private constructor(
    private readonly spendingPrivateKey: Uint8Array,
    private readonly spendingPublicKey: [bigint, bigint],
  ) {}

  static async fromRootSecret(rootSecret: Uint8Array): Promise<LocalSigner> {
    const keyset = await deriveKeyset(rootSecret);
    return new LocalSigner(keyset.spendingPrivateKey, keyset.spendingPublicKey);
  }

  async getSpendingPublicKey(): Promise<[bigint, bigint]> {
    // Return a copy so a caller can't mutate the internal point (which feeds circuit inputs).
    return [this.spendingPublicKey[0], this.spendingPublicKey[1]];
  }

  async signBatch(requests: readonly SpendSignRequest[]): Promise<EddsaSignature[]> {
    if (this.disposed) throw new InvalidRequestError('LocalSigner: used after dispose()');
    return requests.map((request) => {
      const sig = signEDDSA(this.spendingPrivateKey, request.message);
      return { R8: [sig.R8[0], sig.R8[1]] as [bigint, bigint], S: sig.S };
    });
  }

  /** Zeroize the spending private key (SPEC §4.2 zeroization) — the signer refuses to sign afterward. */
  dispose(): void {
    this.spendingPrivateKey.fill(0);
    this.disposed = true;
  }
}
