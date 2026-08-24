---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "@armada/sdk"
  text: "The Armada shielded-pool SDK"
  tagline: Derive wallets, sync from chain, and prove shielded transfers — a small, per-instance TypeScript API.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: API reference
      link: /api/

features:
  - title: Wallets over the pool
    details: Derive spend-capable, view-only, or ephemeral wallets and read balances and history.
  - title: Plan → preflight → prove
    details: Build transfers and unshields, run cheap pre-proof checks, then generate proofs.
  - title: Yours to host
    details: Docs-as-code, encrypted at rest by default, no singletons or global engine state.
---

<!-- TODO(content): refine hero copy and feature cards during the content pass. -->
