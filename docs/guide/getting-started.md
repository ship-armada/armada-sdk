# Getting started

This page walks through installing the SDK, creating an instance, loading a wallet, and reading its
balance.

## Install

The SDK is not on npm yet. Install it from GitHub, pinned to a commit so installs stay reproducible:

```sh
npm install github:ship-armada/armada-sdk#<commit-sha>
```

In `package.json` the pinned dependency looks like this:

```json
{
  "dependencies": {
    "@armada/sdk": "github:ship-armada/armada-sdk#<commit-sha>"
  }
}
```

The build output is not committed, so the package compiles itself on install via its `prepare`
script — no separate build step is needed. Imports use the `@armada/sdk` package name throughout
these docs.

::: info
Once the package is published to npm, install becomes `npm install @armada/sdk`. The import paths
and API stay the same.
:::

The package builds ES module and CommonJS output with TypeScript type declarations. It targets
modern browsers and Node (CI runs on Node 20).

The crypto core runs in WebAssembly (Poseidon hashing and curve25519). `createArmadaSdk` awaits both
WASM modules before it returns, so there is no separate initialization step to call.

## Create an instance

An instance is created with `createArmadaSdk`. It takes a pool description, an RPC endpoint, and
three adapters you provide — storage, a prover, and an artifact source:

```ts
import {
  createArmadaSdk,
  MemoryStorageAdapter,
  createSnarkjsProver,
  HttpArtifactSource,
} from '@armada/sdk';

const sdk = await createArmadaSdk({
  pool: {
    chainId: 8453,
    poolAddress: '0x…',      // the shielded pool contract
    deployBlock: 21_000_000, // the block the pool was deployed at — the scan floor
    usdcAddress: '0x…',
  },
  rpc: { urls: ['https://…'] },
  storage: new MemoryStorageAdapter(),
  prover: createSnarkjsProver(),
  artifacts: new HttpArtifactSource('https://…', { manifest }),
});
```

`pool`, `rpc`, `storage`, `prover`, and `artifacts` are required; the addresses, RPC URL, and
artifact manifest are specific to your deployment. The adapters are covered in
[Adapters](./adapters); everything else has a documented optional field on the config type.

Instances are self-contained — there is no global state, and you can run more than one in a single
process. When you are done, `close()` releases the prover's workers:

```ts
await sdk.close();
```

## Load a wallet

Wallets are created from `sdk.wallet`. Loading from a 32-byte root secret gives a spend-capable
wallet, and `shieldedAddress` is its `0zk` address — the address others shield or transfer to:

```ts
const wallet = await sdk.wallet.fromRootSecret(rootSecret, { creationBlock: 21_000_000 });

console.log(wallet.shieldedAddress); // 0zk…
```

`creationBlock` is where this wallet's scans start. The other ways to load a wallet — from a
mnemonic, a viewing key, or an ephemeral seed — are covered in [Wallets](./wallets).

## Sync and read the balance

A new wallet holds no state until it scans the pool. `sync()` scans from the wallet's last synced
block to the chain head and reports the window it covered:

```ts
const { fromBlock, syncedThrough, scanned } = await wallet.sync();
```

Once synced, `balances()` returns one entry per token the wallet holds, each split into a
`spendable` and a `pending` amount:

```ts
for (const { tokenHash, tokenAddress, spendable, pending } of await wallet.balances()) {
  console.log(tokenHash, tokenAddress, spendable, pending);
}
```

`spendable` and `pending` are `bigint` values in the token's base units. Each entry carries both
`tokenAddress` (the ERC-20 address) and `tokenHash` (the pool's canonical hash of the token, the key
the balance and token events join on) — see [Adapters](./adapters) for how the two relate.

## Next steps

- [Wallets](./wallets) — spend-capable, view-only, and ephemeral wallets
- [Syncing](./syncing) — checkpoints, reorg safety, and scan events
- [Transactions](./transactions) — planning, preflight, and proving
