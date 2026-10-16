# Errors

Every error the SDK throws is an `ArmadaError` with a stable `code`. Match on the code — with
`isArmadaError` — not on the class or the message:

```ts
import { isArmadaError } from '@armada/sdk';

try {
  await wallet.sync();
} catch (err) {
  if (isArmadaError(err, 'RPC') && err.transport) {
    // The node couldn't be reached: retry later, or on another RPC.
  } else if (isArmadaError(err)) {
    console.error(err.code, err.message);
  } else {
    throw err; // not the SDK's
  }
}
```

`isArmadaError(err)` is true for any SDK error, and `isArmadaError(err, code)` for one with that
code. It works on the code, so it also recognises an error from another copy of the SDK — `instanceof`
is false when the SDK is loaded twice, for example once as an ES module and once as CommonJS. An error
from another library with a `code` field (ethers' `NETWORK_ERROR`, say) isn't an SDK error. The full
list is exported as `ERROR_CODES`, with its type `ErrorCode`.

Errors keep their class and code when they cross the prover's worker boundary.

## Codes

| Code | Class | Thrown when | What to do |
|---|---|---|---|
| `ABORTED` | `AbortedError` | A proof (or its artifact download) was cancelled through its `AbortSignal`. | Nothing; the caller cancelled it. |
| `ARTIFACT_FETCH` | `ArtifactFetchError` | A proving-artifact download failed or timed out. `status` is the HTTP status, when there was one. | Retry; check the artifact URL. |
| `ARTIFACT_INTEGRITY` | `ArtifactIntegrityError` | Downloaded artifacts don't match the manifest's digests. | Don't use them; check the artifact host. |
| `FEE_QUOTE_EXPIRED` | `FeeQuoteExpiredError` | `assertPreflight`: the fee quote expires before the spend could land. | Get a fresh quote and re-plan. |
| `INDEXER_HTTP` | `IndexerHttpError` | The quick-sync indexer answered with a non-OK status (`status`). Sync falls back to RPC on its own, so you'll see this in telemetry, not thrown. | Check the indexer URL. |
| `INSTANCE_CLOSED` | `InstanceClosedError` | A call after `sdk.close()` or `wallet.dispose()`, or a sync or proof they cut short; a closed storage adapter. | Nothing, if you closed it; otherwise create a new instance. |
| `INSUFFICIENT_BALANCE` | `InsufficientBalanceError` | No single tree's spendable notes cover the spend and its fee. | Spend less, wait for pending notes, or consolidate. |
| `INTERNAL` | `InternalError` | An SDK invariant broke: a bug, or state the SDK didn't write (a foreign storage record, artifacts the prover can't use). | Report it. |
| `INVALID_CONFIG` | `InvalidConfigError` | A malformed config at `createArmadaSdk`, or an RPC that doesn't serve the configured chain or pool. | Fix the config. |
| `INVALID_KEY_MATERIAL` | `InvalidKeyMaterialError` | A key failed validation: malformed or truncated, a zero scalar, an off-curve point. | Check the key's source. |
| `INVALID_REQUEST` | `InvalidRequestError` | A request the SDK won't act on: a bad amount, a cross-chain unshield the pool would reject, a plan with no merkle proofs. | Fix the request. |
| `NO_SPEND_CAPABILITY` | `NoSpendCapabilityError` | A spend-path call on a view-only wallet. | Attach a signer. |
| `NOTE_ALREADY_SPENT` | `NoteAlreadySpentError` | `assertPreflight`: an input note is already spent on-chain. | Sync, then re-plan. |
| `NOTHING_TO_CONSOLIDATE` | `NothingToConsolidateError` | `consolidate` found nothing worth merging. | Nothing to do. |
| `POSITION_GAP` | `PositionGapError` | A merkle tree received a leaf out of order. Sync recovers from it by rescanning. | Nothing, unless it persists. |
| `PROOF_EXPIRED` | `ProofExpiredError` | A `ProofHandle` was used past its `expiresAt`. | Re-plan and re-prove. |
| `PROOF_HANDLE_INVALIDATED` | `ProofHandleInvalidatedError` | A `ProofHandle` was used after `invalidate()`. | Re-plan and re-prove. |
| `PROOF_VERIFICATION` | `ProofVerificationError` | A fresh proof failed its local check, so it would revert on-chain. | Report it. |
| `PROVER_WORKER` | `ProverWorkerError` | The prover worker crashed, failed to load, or was terminated; the prover was closed; or the worker reported an error with no SDK code. | Retry: the next proof starts a fresh worker. |
| `QUICK_SYNC_SCHEMA` | `QuickSyncSchemaError` | The indexer served data that doesn't match its schema or its leaf hashes. Sync falls back to RPC on its own. | Check the indexer. |
| `ROOT_MISMATCH` | `RootMismatchError` | A synced tree doesn't match the pool's on-chain root, or a plan's root is no longer accepted. | Retry the sync (the RPC may have returned incomplete logs); re-plan a spend. |
| `RPC` | `RpcError` | An RPC call failed. `method` names it, `cause` is the provider's error, and `transport` is true when the node couldn't be reached. | Retry later or on another RPC when `transport` is true; otherwise check the node. |
| `SIGNER_CONTRACT_VIOLATION` | `SignerContractViolationError` | A `SpendSigner` broke its contract: the wrong key, a bad or missing signature. | Fix the signer. |
| `STORAGE_CONFLICT` | `StorageConflictError` | Another live instance holds the storage (another tab or process), or an open adapter was asked to rebind to another deployment. | Close the other instance first. |
| `STORAGE_UNAVAILABLE` | `StorageUnavailableError` | The browser has no Web Locks API (an insecure context, or a very old browser), so the IndexedDB adapter won't open unlocked. | Serve the app over HTTPS, or use a current browser. |
| `TOO_FRAGMENTED` | `TooFragmentedError` | A spend needs more input notes than one batch of proofs can hold. | Consolidate first. |
| `UNSUPPORTED_CIRCUIT_SHAPE` | `UnsupportedCircuitShapeError` | A plan needs a circuit shape the deployment has no artifacts for. | Consolidate, or register the shape. |
