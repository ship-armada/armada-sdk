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

Its `close()` releases the prover's workers and is called for you by `sdk.close()`.

## Artifacts

The artifact source resolves the circuit artifacts (wasm, zkey, vkey) for a given circuit shape. The
circuit wasm and zkey receive the full private witness, so integrity matters — the built-ins verify
each resolved artifact against a pinned manifest:

```ts
import {
  HttpArtifactSource,
  FilesystemArtifactSource,
  VerifiedArtifactSource,
} from '@armada/sdk';

new HttpArtifactSource('https://…', { manifest });           // fetch over HTTP
new FilesystemArtifactSource('/path/to/artifacts');          // read from disk (Node)
new VerifiedArtifactSource(                                   // wrap any source with verification
  new FilesystemArtifactSource('/path/to/artifacts'),
  manifest,
);
```

`HttpArtifactSource` requires either a `manifest` or an explicit `dangerouslySkipIntegrity: true` —
there is no unverified default. The manifest is a build-time trust anchor pinned in your app; it
should not be fetched from the same origin as the artifacts, or the integrity check is
self-referential.

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
tokens (the `additionalTokens` config is deprecated and ignored). `tokenAddress` resolves for every
ERC20 balance; it is typed optional only to guard a non-ERC20 (e.g. NFT) hash, which is out of scope
and never returns a hidden balance.
