# Security

This page covers the SDK's security-relevant behavior: encryption at rest, the escape hatch that
disables it, what telemetry is allowed to see, and the split between spending and viewing.

## Encryption at rest

Each wallet's persisted data — its notes, spends, and history — is encrypted before it reaches your
storage adapter. Values are AES-256-GCM encrypted under a per-wallet key derived from the wallet's
viewing key with HKDF-SHA-256, using a fresh random nonce per record. Your
[storage adapter](./adapters) only ever sees ciphertext; it stores and retrieves bytes and never
handles keys. Record names (the keys your adapter stores values under) are stored as-is, so they never
contain a wallet's `0zk` address: each wallet's records are named by an opaque id derived from its
viewing key.

This is on by default and wraps whatever adapter you pass, so plaintext note data never reaches
disk.

One kind of record is stored unencrypted: the SDK instance's copy of the pool's merkle trees and the
block they're synced through. Those are public chain data — the leaf hashes anyone can read from the
pool's events — and are shared by every wallet on the instance, so they don't identify a wallet.

## Disabling encryption

The `dangerouslyAllowPlaintextStorage` flag turns off at-rest encryption and writes plaintext
straight to your adapter:

```ts
const sdk = await createArmadaSdk({
  // …
  dangerouslyAllowPlaintextStorage: true,
});
```

::: warning
This is intended only for ephemeral or test stores where at-rest secrecy is a non-goal. Leave it
unset in production.
:::

## Telemetry

You can pass an optional telemetry sink to receive operational events. Every event and its payload is
typed in `TelemetryEventMap`, and checking the event name narrows the payload:

```ts
const sdk = await createArmadaSdk({
  // …
  telemetry: {
    emit(event, data) {
      if (event === 'sync.quicksync') myMetrics.record(event, data.outcome); // data: QuickSyncTelemetry
    },
  },
});
```

| Event | Payload |
| --- | --- |
| `sync.quicksync` | `{ outcome, fromBlock, head, tailCovered, reason?, status? }` — whether a configured indexer served a verified batch |
| `sync.reorg-recovery` | `{ fromBlock, reason }` — a wallet discarded its chain-derived state and is rescanning |
| `storage.chain-reset` | `{ chainId, deployBlock }` — storage belonged to another deployment and was reset |

Telemetry events exclude secret and identifying material by design — key material, seeds, memo
plaintext, amounts, and shielded addresses are never emitted to the sink. Payloads carry only block
numbers, public chain config, booleans and enums, and the types enforce that: a payload can't gain a
field without a change to `TelemetryEventMap`.

## What your RPC provider sees

The RPC provider (usually a third party) sees every request the SDK makes, with your client's IP. The
SDK keeps those requests from pointing at a wallet's own transactions:

- A sync reads the pool's logs by block range, so the provider can't tell which events are the
  wallet's. It also fetches the timestamp of every block in the range that has a pool event — not
  only the wallet's — and the wallet keeps the ones it needs.
- `history()` makes no network request at all: its timestamps come from the sync.
- `preflight()` is the exception: it asks the pool whether a plan's input notes are already spent,
  so the provider sees those nullifiers shortly before the transaction that publishes them. Skip it,
  or point it at a provider you trust, if that link matters for your app.

## Spending and viewing

A wallet's ability to spend lives behind a signer, separate from its ability to view. View-only
wallets and shareable viewing keys grant read access — scanning, balances, history — without spend
power.

To keep the spend key out of the SDK entirely, load the wallet from its shareable viewing key and
attach an [`ExternalSigner`](./wallets#keeping-the-spend-key-out-of-the-sdk) that produces signatures
in your own backend. Passing a signer to `fromRootSecret` or `fromMnemonic` is not enough: those derive
the spend key from the secret first. The SDK zeroes that copy at once, but it was in memory. Either
way, the SDK checks that the signer holds the wallet's spending key, and checks every signature it
returns before proving with it; a mismatch is a `SignerContractViolationError`.

A signer may also implement `dispose()` to release held key material when it is no longer needed.
`wallet.dispose()` and `sdk.close()` dispose the signer the SDK made for a wallet (a signer you passed
in is yours to dispose) and wipe the wallet's viewing key. The default `LocalSigner` holds the only
copy of the spend key, so disposing it wipes the key.

Key wiping is best-effort. JavaScript can't wipe strings or bigints: the nullifying key is a bigint,
the root secret you pass in is yours to wipe, and the engine's key derivation and signing make
temporary hex-string copies of key material that stay in memory until garbage collection. Treat
wiping as reducing exposure, not as a guarantee that no copy remains.
