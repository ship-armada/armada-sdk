# 2026-09 consolidation review: repro tests

**This branch is never merged.** It keeps the proof-of-bug tests and scripts from the September 2026
consolidation review of `@armada/sdk` at `ef6bed6`. Each finding ID (e.g. `SYNC-1`, `TX-4`) is tracked in a
GitHub issue labelled [`review-2026-09`](https://github.com/ship-armada/armada-sdk/issues?q=label%3Areview-2026-09).
The pinned tracker issue lists every ID, where it's tracked, and its status.

Each test **passes while the bug exists**: it asserts the buggy behaviour. When you fix a finding, copy
its test into the real suite (`src/**`) and flip the assertion to the correct behaviour, so it fails first
and passes once the fix lands.

## Running

From a checkout of this branch, after `npm ci`:

```sh
npm run build:vendor
node_modules/.bin/vitest run --config review-2026-09/vitest.repro.config.ts --root . review-2026-09/repro/<area>
```

Areas: `api`, `sync`, `tx`, `prover`, `wallet-storage`, `crosscut/tests`. `sync/merkle-cost.test.ts` takes
about 25 s; it's a timing measurement, not a pass/fail check.

## Build and packaging scripts (`crosscut/`)

These need `npm run build` first (they read `dist/`).

| Script | Finding | Run |
|---|---|---|
| `dual.mjs` | XC-1: each entry point has its own classes and state | `node review-2026-09/repro/crosscut/dual.mjs` |
| `tsup.split.config.ts` + `dual-split.mjs` | XC-1 fix check with `splitting: true` | `node_modules/.bin/tsup --config review-2026-09/repro/crosscut/tsup.split.config.ts`, then `node …/dual-split.mjs` |
| `consumer-root.mjs` / `consumer-both.mjs` | XC-1 bundle doubling, XC-2 Node built-ins in the browser build | `node_modules/.bin/esbuild --bundle --platform=browser --minify <file> --outfile=/tmp/out.js` |
| `vite/` | XC-2 Vite externalization warnings | `node_modules/.bin/vite build review-2026-09/repro/crosscut/vite` |
| `typescjs/` | XC-3 TS1479 for CJS consumers | symlink the package as `node_modules/@armada/sdk` there, then `tsc -p` |
| `docs/extract.mjs` | XC-7 docs code samples typecheck | `node …/extract.mjs && node_modules/.bin/tsc -p review-2026-09/repro/crosscut/docs` |
| `node-esm-smoke.mjs` | control: Node ESM consumers work | `node …/node-esm-smoke.mjs` |
