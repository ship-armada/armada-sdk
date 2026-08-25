# Developer docs

This directory is the source for the `@armada/sdk` documentation site, built with
[VitePress](https://vitepress.dev). Hand-written guides live in `guide/`, and the API reference is
generated from the SDK's TSDoc comments with [TypeDoc](https://typedoc.org).

## Working on the docs

Run a hot-reloading dev server (default `http://localhost:5173`):

```sh
npm run docs:dev
```

`docs:dev` does not generate the API reference, so the **API** section is empty until you build it
once. For the full site including the API reference:

```sh
npm run docs:api   # generate docs/api/ (builds the vendored sources first, then runs TypeDoc)
npm run docs:dev   # then start the dev server
```

To preview the exact production build instead of the dev server:

```sh
npm run docs:api && npm run docs:build && npm run docs:preview
```

## Layout

| Path | What it is |
| --- | --- |
| `guide/*.md` | Hand-written guide pages |
| `index.md` | Landing page |
| `.vitepress/config.mts` | Site config — nav, sidebar, search |
| `public/CNAME` | Custom domain for GitHub Pages (`docs.armada.blue`) |
| `api/` | Generated API reference — git-ignored, built by `docs:api` |

## Deployment

The site deploys to GitHub Pages via `.github/workflows/docs.yml` on every push to `main` that
touches the docs, the SDK sources, or the docs tooling. The workflow runs `docs:api` and
`docs:build`, then publishes `docs/.vitepress/dist`.

Generated output (`docs/.vitepress/dist`, `docs/api`) is git-ignored and produced in CI — it is not
committed.
