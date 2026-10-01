# Adapters

`createArmadaSdk` takes three adapters you provide: storage, a prover, and an artifact source. This
page covers the built-in implementations and how to resolve a balance's token hash back to an
address.

## Storage

The storage adapter persists scan state, notes, and balances. It is a key-value store with prefix
iteration (`get`, `put`, `del`, `list`, plus `open`/`close` and a chain-state reset). Three
implementations ship with the SDK:

```ts
import {
  MemoryStorageAdapter,
  IndexedDBStorageAdapter,
  LevelStorageAdapter,
} from '@armada/sdk';

new MemoryStorageAdapter();             // in-memory; nothing persists across processes
new IndexedDBStorageAdapter('armada');  // browser; persists to the named IndexedDB database
new LevelStorageAdapter(db);            // Node; wraps an abstract-level database instance
```

- `MemoryStorageAdapter` — good for tests and ephemeral use; state is lost when the process exits.
- `IndexedDBStorageAdapter` — browser persistence, keyed by the database name you pass.
- `LevelStorageAdapter` — Node persistence over any `abstract-level` database.

Note data is [encrypted at rest](./security) on top of whatever adapter you pass, so a custom
adapter does not need to handle encryption itself — it only needs to store and retrieve bytes.

## Prover

The prover generates the Groth16 proofs. The built-in `createSnarkjsProver` returns a ready
`ProverAdapter`:

```ts
import { createSnarkjsProver } from '@armada/sdk';

const prover = createSnarkjsProver();
```

It proves on the calling thread. Its `close()` releases the prover's workers and is called for you
by `sdk.close()`. snarkjs shares one curve (with its worker threads) across every same-thread prover in
the process, so the curve is only torn down once the last open prover closes and no proof is running.

In the browser, prove off the main thread with `createWorkerProver`. It takes a function that starts a
worker, pointed at the SDK's prebuilt worker entry:

```ts
import { createWorkerProver, webWorkerChannel } from '@armada/sdk';

const prover = createWorkerProver(() =>
  webWorkerChannel(new Worker(new URL('@armada/sdk/prover/worker', import.meta.url), { type: 'module' })),
);
```

The worker is started on the first request. If it crashes (for example, out of memory on a large
zkey), its in-flight requests reject with `ProverWorkerError`, and the next request starts a fresh
worker. Cancelling a proof terminates the worker, because snarkjs can't be interrupted mid-proof. Any
other request running on it also rejects with `ProverWorkerError`, and the next request starts a fresh
worker.

## Artifacts

The artifact source resolves the circuit artifacts (wasm, zkey, vkey) for a given circuit shape. The
circuit wasm and zkey receive the full private witness, so integrity matters — check each resolved
artifact against a pinned manifest:

```ts
import { HttpArtifactSource, VerifiedArtifactSource } from '@armada/sdk';
import { FilesystemArtifactSource } from '@armada/sdk/node';

new HttpArtifactSource('https://…', { manifest });              // fetch over HTTP
new FilesystemArtifactSource('/path/to/artifacts', { manifest }); // read from disk (Node only)
new VerifiedArtifactSource(mySource, manifest);                   // add the check to a source of your own
```

Both built-in sources verify against their manifest, and each requires either a `manifest` or an
explicit `dangerouslySkipIntegrity: true` — there is no unverified default. `FilesystemArtifactSource`
is on the Node-only `@armada/sdk/node` entry, so a browser bundle never has to resolve `node:fs`. Wrap
a source of your own in a `VerifiedArtifactSource` to get the same check. The manifest is a build-time trust anchor pinned in your app; it
should not be fetched from the same origin as the artifacts, or the integrity check is
self-referential.

`HttpArtifactSource` gives up on a download that takes longer than `timeoutMs` (default 120 000 ms),
and cancelling a proof also cancels an artifact download that is still in flight.

In the browser, wrap the source in an `IndexedDbArtifactCache` so the multi-MB zkey is downloaded once
rather than for every proof:

```ts
import { IndexedDbArtifactCache } from '@armada/sdk';

new IndexedDbArtifactCache(new HttpArtifactSource('https://…', { manifest }), { manifest });
```

Cache entries are keyed by the artifact digests in the pinned manifest. Shipping new circuits with a
new manifest is therefore a cache miss, and old artifacts are never served. The cache stores and
returns only bytes that match the manifest. `clear()` drops every entry, including those left behind
by earlier manifests.

## Token identifiers on balances and events

Every token-bearing surface carries the same pair of identifiers, so a live event joins a
`balances()` snapshot without a lookup of your own:

- **`tokenHash`** — the canonical 32-byte token hash, without a `0x` prefix. This is the identifier
  the pool stores inside a commitment, and the key `balances()` and the token events agree on.
- **`tokenAddress`** — the token's ERC-20 address, derived directly from `tokenHash` (an ERC20 token
  hash is the address, zero-padded to 32 bytes — so no registry or pre-configuration is needed).

```ts
for (const { tokenHash, tokenAddress, spendable, pending } of await wallet.balances()) {
  console.log(tokenHash, tokenAddress, spendable, pending);
}
```

The wallet scans, reports, and reconstructs history for **any pool ERC20** — you don't pre-register
tokens. `tokenAddress` resolves for every ERC20 balance; it is typed optional only to guard a
non-ERC20 (e.g. NFT) hash, which is out of scope and never returns a hidden balance.
