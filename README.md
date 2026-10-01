# @armada/sdk

A fork-and-shrink replacement of the Railgun SDK stack, owning the shielded-pool crypto core,
wallet layer, payments, and operations journal for the Armada protocol.

**Status:** Phases 0–2 are complete (`SPEC.md` §10): the pinned crypto core at parity, and the wallet
layer — storage, sync, keys and signers, proving, transaction building and preflight. Phase 3 (payments)
and Phase 4 (the operations journal) are next.

## What this is

- A browser-first, Node-compatible TypeScript package (`@armada/sdk`) with subpath exports:
  `@armada/sdk/core`, `/wallet`, `/prover`, `/prover/worker` (the prebuilt Web Worker entry), and
  `/node` (Node-only adapters such as `FilesystemArtifactSource`). All entries share one copy of the
  engine. `/payments` and `/ops` arrive with Phases 3 and 4.
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
