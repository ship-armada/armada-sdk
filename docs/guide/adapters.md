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

## Resolving token balances to addresses

`balances()` returns entries keyed by `tokenHash` — the canonical 32-byte token hash, without a `0x`
prefix — not by address. To map those back to addresses, build a lookup from the tokens you already
know about: the pool's USDC and any `additionalTokens` on the pool config.

```ts
import { getTokenDataERC20, getTokenDataHash } from '@armada/sdk';

const known = [usdcAddress, ...additionalTokens];
const addressByHash = new Map(
  known.map((address) => [getTokenDataHash(getTokenDataERC20(address)), address]),
);

for (const { tokenHash, spendable, pending } of await wallet.balances()) {
  const address = addressByHash.get(tokenHash); // undefined for a token not in `known`
  console.log(address, spendable, pending);
}
```

The wallet only scans balances for the pool's USDC and the `additionalTokens` you list — a note in
any other token is skipped during the scan, so every `tokenHash` returned resolves to a token you
configured.
