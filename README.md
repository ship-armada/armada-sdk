# @armada/sdk

A fork-and-shrink replacement of the Railgun SDK stack, owning the shielded-pool crypto core,
wallet layer, payments, and operations journal for the Armada protocol.

**Status:** Phase 1 (bootstrap + pinned-core parity). The package skeleton, vendoring provenance
(`NOTICE.md`), and Phase 0 differential vectors (`test/vectors/`) are in place; the vendored
`core/` and its differential runner land in Phase 1.

## What this is

- A browser-first, Node-compatible TypeScript package (`@armada/sdk`) with subpath exports:
  `@armada/sdk/core`, `/wallet`, `/payments`, `/ops`.
- A **byte-compatible** reimplementation of the pinned Railgun crypto core (Poseidon/BN254,
  commitments, nullifiers, merkle math, note ECIES, EdDSA spend authorization, `TransactionStructV2`
  serialization) — enforced forever by the differential vector suite in `test/vectors/`.
- PPOI (proof of innocence) is **not** included — stripped at vendor time (see `SPEC.md` §3.5).

## Canonical spec

`SPEC.md` is the authoritative specification and phased implementation plan (mirrored from the
Armada POC repo's `specs/ARMADA_SDK.md`). Read it first.

## Provenance

`vendor/railgun-engine/` holds a pruned subset of the Railgun engine's MIT-licensed TypeScript
sources at tag `v9.6.0`, with tag↔npm verification recorded in `NOTICE.md`.
