---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "@armada/sdk"
  text: "The Armada shielded-pool SDK"
  tagline: Derive wallets, sync from chain, and prove shielded transfers — a small, per-instance TypeScript API.
  image:
    src: /armada-mark-color.png
    alt: Armada
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
  - title: Per-instance by design
    details: Self-contained instances with no global state, and note data encrypted at rest by default.
---
