# Overview

`@armada/sdk` is a TypeScript SDK for the Armada shielded pool. It provides wallets that scan the
pool from chain, report balances and history, and plan and prove shielded transactions — through a
small, per-instance API.

## Shielded pool concepts

In a shielded pool, funds are held as encrypted **notes** rather than as public balances. A few terms
recur throughout these docs:

- **Shield / unshield** — a shield deposits public funds into the pool as a note; an unshield
  withdraws a note back out to a public address.
- **Transfer** — moving funds between shielded (`0zk`) addresses inside the pool.
- **Viewing key** — detects and decrypts a wallet's own notes; balances and history are derived from
  them.
- **Spending key** — authorizes spends by producing a zero-knowledge proof of note ownership, without
  revealing which notes were spent.

A wallet has no state until it scans the pool's events to find the notes addressed to it. From that
scanned set it computes balances and history, and selects notes to spend when building a transaction.

## The instance model

An SDK instance is created with `createArmadaSdk` and is fully self-contained — there is no global
state, and you can run more than one instance in a single process. An instance holds the pool
configuration and the adapters, and hands out wallets:

```ts
const sdk = await createArmadaSdk(config);
const wallet = await sdk.wallet.fromRootSecret(rootSecret, { creationBlock });
```

## How the pieces fit

A typical flow moves through the guide in order:

1. **[Getting started](./getting-started)** — create an instance and load a wallet.
2. **[Wallets](./wallets)** — spend-capable, view-only, and ephemeral wallets, and signers.
3. **[Syncing](./syncing)** — scan the pool, then read balances and history.
4. **[Transactions](./transactions)** — plan, preflight, and prove a transfer or unshield.
5. **[Adapters](./adapters)** — the storage, prover, and artifact sources you provide.
6. **[Security](./security)** — encryption at rest, telemetry, and the spend/view split.

## Project status

The SDK is in active development and pre-1.0; the API may change. Installation currently uses a
pinned GitHub commit — see [Getting started](./getting-started).
