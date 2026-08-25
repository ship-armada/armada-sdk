# Wallets

Wallets are created from `sdk.wallet`. This page covers the ways to load one, how spend capability
works, and how to share read-only access.

## Spending and viewing keys

A wallet derives two kinds of keys:

- A **spending key** authorizes spends and produces the proofs that move funds.
- A **viewing key** detects and decrypts the wallet's own notes, which is what balances and history
  are computed from.

The two are separable. Sharing only the viewing key grants someone the ability to *see* a wallet's
activity without the ability to *spend* from it — the basis for view-only wallets and shareable
viewing keys below.

## Loading a wallet

### From a root secret

A 32-byte root secret gives a spend-capable wallet:

```ts
const wallet = await sdk.wallet.fromRootSecret(rootSecret, { creationBlock: 21_000_000 });
```

### From a mnemonic

A BIP-39 mnemonic works too; the checksum is validated on load. `derivationIndex` defaults to `0`:

```ts
const wallet = await sdk.wallet.fromMnemonic(mnemonic, {
  creationBlock: 21_000_000,
  derivationIndex: 0,
});
```

### View-only from a viewing key

A shareable viewing key produces a wallet that can scan, report balances, and reconstruct history,
but cannot spend:

```ts
const wallet = await sdk.wallet.viewOnlyFromViewingKey(shareableViewingKey, {
  creationBlock: 21_000_000,
});
```

### Ephemeral from a seed

An ephemeral wallet is held in memory only and never written to storage — its `persists` flag is
`false`. It takes no `creationBlock`:

```ts
const wallet = await sdk.wallet.ephemeralFromSeed(seed);

wallet.persists; // false
```

## Spend capability

`canSpend` reflects whether a wallet has a signer attached. `fromRootSecret` and `fromMnemonic` are
spend-capable by default. Pass `viewOnly: true` to load a wallet that can scan and report but holds
no signer:

```ts
const viewOnly = await sdk.wallet.fromRootSecret(rootSecret, {
  creationBlock: 21_000_000,
  viewOnly: true,
});

viewOnly.canSpend; // false
```

Calling a spend-path method — `planTransfer` or `prove` — on a wallet without a signer throws
`NoSpendCapabilityError`:

```ts
import { NoSpendCapabilityError } from '@armada/sdk';

try {
  await viewOnly.planTransfer(request);
} catch (err) {
  err instanceof NoSpendCapabilityError; // true
}
```

## Signers

Spend authorization goes through a `SpendSigner`:

```ts
interface SpendSigner {
  getSpendingPublicKey(): Promise<[bigint, bigint]>;
  signBatch(requests: readonly SpendSignRequest[]): Promise<EddsaSignature[]>;
  dispose?(): void;
}
```

By default the SDK attaches a `LocalSigner` derived from the secret you loaded the wallet with. To
produce spend signatures elsewhere — a remote service, an HSM, a hardware device — attach an
`ExternalSigner`, which delegates both calls to backends you provide:

```ts
import { ExternalSigner } from '@armada/sdk';

const signer = new ExternalSigner(
  (requests) => myBackend.signBatch(requests),   // => Promise<EddsaSignature[]>
  () => myBackend.getSpendingPublicKey(),        // => Promise<[bigint, bigint]>
);

const wallet = await sdk.wallet.fromRootSecret(rootSecret, {
  creationBlock: 21_000_000,
  signer,
});
```

An explicit `signer` always takes precedence over the default `LocalSigner`. `fromMnemonic` accepts
the same `signer` option.

## Sharing a viewing key

`shareViewingKey()` returns a string encoding a wallet's viewing capability. Pass it to
`viewOnlyFromViewingKey` to reconstruct a view-only wallet — useful for reporting or monitoring
without exposing spend power:

```ts
const shareable = wallet.shareViewingKey();

const viewOnly = await sdk.wallet.viewOnlyFromViewingKey(shareable, {
  creationBlock: 21_000_000,
});
```

`shareViewingKey()` is available on view-only wallets too.

::: info Compatibility
Shareable viewing keys use a wire format that is byte-compatible with other wallets over the same
shielded-pool design, so a key can be moved between compatible wallets. This is a wire-format
compatibility only — each wallet still scans the pool it is configured for.
:::
