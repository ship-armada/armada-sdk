// ABOUTME: ExternalSigner test double (SPEC §4.2.1) — a SpendSigner that delegates to an injected
// ABOUTME: backend, standing in for an out-of-process signer (HSM/enclave/Salt-gated) in tests.

import type { SpendSigner, SpendSignRequest, EddsaSignature } from './index';

/** Signature backend: receives the ENTIRE batch of intents at once, returns one signature per request. */
export type SignBackend = (requests: readonly SpendSignRequest[]) => Promise<EddsaSignature[]>;
export type PublicKeyBackend = () => Promise<[bigint, bigint]>;

/**
 * In-process `ExternalSigner`. Real integrations implement this boundary over an out-of-process
 * transport (transport + policy gating are the integration's concern, NOT the SDK's — SPEC §4.2.1);
 * the SDK ships only the interface and this test double. It preserves the batch-before-any-signature
 * property (the whole batch is handed to the backend in one call) and checks the returned count.
 */
export class ExternalSigner implements SpendSigner {
  constructor(
    private readonly signBackend: SignBackend,
    private readonly publicKeyBackend: PublicKeyBackend,
  ) {}

  getSpendingPublicKey(): Promise<[bigint, bigint]> {
    return this.publicKeyBackend();
  }

  async signBatch(requests: readonly SpendSignRequest[]): Promise<EddsaSignature[]> {
    const signatures = await this.signBackend(requests);
    if (signatures.length !== requests.length) {
      throw new Error(
        `ExternalSigner: backend returned ${signatures.length} signatures for ${requests.length} requests`,
      );
    }
    return signatures;
  }
}
