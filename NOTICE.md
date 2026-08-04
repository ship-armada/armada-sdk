# NOTICE — third-party attribution & vendoring provenance

## Vendored: Railgun engine (`vendor/railgun-engine/`)

`@armada/sdk` vendors a pruned subset of the Railgun engine's TypeScript sources under
`vendor/railgun-engine/`. Upstream is MIT licensed; the upstream `LICENSE` is preserved at
`vendor/railgun-engine/LICENSE`.

| Field | Value |
|---|---|
| Upstream repo | https://github.com/Railgun-Community/engine |
| Vendored tag | `v9.6.0` |
| Tag commit SHA | `f767362661b24cf17ff7fe6f4e0d14a4b5b31adc` |
| npm package | `@railgun-community/engine@9.6.0` |
| npm tarball shasum | `c2d2f07bd37dce7c95f65ab827131e4c1fdc0683` |
| License | MIT (© 2022 RAILGUN Project Contributors) |

### Tag ↔ npm verification (per SPEC §3.4) — verified 2026-08-04

The npm artifact is what production code actually runs; the vendored git tag must match it.

1. **Version equality.** `package.json` `version` at tag `v9.6.0` === published npm version === `9.6.0`.
2. **Source ↔ compiled spot-diff.** The published npm `dist/*.js` were confirmed to be exact
   transpilations of the tag's `src/*.ts` for core pinned-crypto primitives:
   - `utils/poseidon` — verbatim (logic + comments).
   - `note/transact-note` `getHash` = `poseidon([notePublicKey, hexToBigInt(tokenHash), value])`
     and `getNullifier(nullifyingKey, leafIndex)` — identical.
   - `models/merkletree-types` — tree depth 16, 65536 leaves/tree.

   **Result: MATCH.** The tag source corresponds to the published npm artifact.

PPOI (proof of innocence) code is stripped at vendor time — not present in `vendor/` — per SPEC §3.5.
