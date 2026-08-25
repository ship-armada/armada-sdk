# Security

This page covers the SDK's security-relevant behavior: encryption at rest, the escape hatch that
disables it, what telemetry is allowed to see, and the split between spending and viewing.

## Encryption at rest

Each wallet's persisted data — notes, balances, and scan state — is encrypted before it reaches your
storage adapter. Values are AES-256-GCM encrypted under a per-wallet key derived from the wallet's
viewing key with HKDF-SHA-256, using a fresh random nonce per record. Your
[storage adapter](./adapters) only ever sees ciphertext; it stores and retrieves bytes and never
handles keys.

This is on by default and wraps whatever adapter you pass, so plaintext note data never reaches
disk.

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

You can pass an optional telemetry sink to receive operational events:

```ts
interface TelemetrySink {
  emit(event: string, data: Readonly<Record<string, unknown>>): void;
}

const sdk = await createArmadaSdk({
  // …
  telemetry: { emit: (event, data) => myMetrics.record(event, data) },
});
```

Telemetry events exclude secret and identifying material by design — key material, seeds, memo
plaintext, and shielded addresses are never emitted to the sink.

## Spending and viewing

A wallet's ability to spend lives behind a signer, separate from its ability to view. View-only
wallets and shareable viewing keys grant read access — scanning, balances, history — without spend
power.

To keep spend keys out of the SDK entirely, attach an [`ExternalSigner`](./wallets#signers) that
produces signatures in your own backend. A signer may also implement `dispose()` to release held key
material when it is no longer needed.
