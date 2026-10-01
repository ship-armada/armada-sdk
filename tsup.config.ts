// ABOUTME: tsup build config for @armada/sdk — a browser-first ESM build (self-contained, Node-builtin polyfilled) + a
// ABOUTME: Node CJS build (real builtins), each code-split so every entry shares one engine copy (#116).

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Plugin } from 'esbuild'
import { defineConfig } from 'tsup'
import { polyfillNode } from 'esbuild-plugin-polyfill-node'

// wasm-pack (web target) fetches its binary via `new URL('x_bg.wasm', import.meta.url)`. In a bundled
// browser library that URL resolves to a nonexistent path → the browser gets index.html back
// ("expected magic word … found 3c 21 64 6f"). esbuild's own `new URL`/dataurl asset handling doesn't
// reliably rewrite it, so inline the sibling `.wasm` ourselves as a base64 data URL — fully
// self-contained, no fetch of an external asset.
const inlineWasmUrl: Plugin = {
  name: 'inline-wasm-url',
  setup(build) {
    build.onLoad({ filter: /_wasm\.js$/ }, async ({ path }) => {
      let code = await readFile(path, 'utf8')
      const ref = code.match(/new URL\('([^']+_bg\.wasm)', ?import\.meta\.url\)/)
      const wasmFile = ref?.[1]
      if (ref && wasmFile) {
        const wasmBytes = await readFile(resolve(dirname(path), wasmFile))
        const dataUrl = `data:application/wasm;base64,${wasmBytes.toString('base64')}`
        code = code.replace(ref[0], `new URL('${dataUrl}')`)
      }
      return { contents: code, loader: 'js' }
    })
  },
}

const entry = {
  index: 'src/index.ts',
  'core/index': 'src/core/index.ts',
  'wallet/index': 'src/wallet/index.ts',
  // Node-only adapters (`node:fs`). Kept off the browser entries; its `node:` imports stay external below.
  'node/index': 'src/node/index.ts',
  // Lean prover entry — prover code + snarkjs only, NO vendored engine/core/wasm. A browser Web
  // Worker imports this (not the 13MB wasm-inlined root) so the worker chunk stays small + bundles fast.
  'prover/index': 'src/prover/index.ts',
  // Prebuilt Web Worker entry — self-wires the prover handler; point a browser Worker at it directly.
  'prover/worker': 'src/prover/worker-entry.ts',
}

export default defineConfig([
  // ── Browser ESM ──────────────────────────────────────────────────────────
  // The vendored Railgun engine is CJS; esbuild wraps every `require()` in a `__require` shim that
  // throws "Dynamic require … not supported" in a browser bundler. So the browser build must resolve
  // ALL requires: bundle the crypto deps + ethers, and POLYFILL Node builtins (crypto/buffer/…) with
  // browser shims. Goal: zero `__require` in the ESM output. snarkjs stays external — it's a lazy
  // `await import` in the prover (a real dynamic import Vite handles, never hit on the read path).
  // Code splitting puts shared modules (the engine, its inlined wasm, the error classes) in shared chunks, so
  // importing several entries loads ONE copy with one module state (#116). The `node:` built-ins only the
  // `/node` entry uses stay external, so that entry keeps real Node imports; no browser entry reaches them
  // (src/packaging.test.ts).
  {
    entry,
    format: ['esm'],
    platform: 'browser',
    dts: true,
    clean: true,
    splitting: true,
    sourcemap: true,
    target: 'es2022',
    external: ['snarkjs', 'node:fs/promises', 'node:path'],
    // tsup externalizes package `dependencies` by default; force the crypto/serialization deps to be
    // bundled so none survive as a `__require` shim. (ethers is bundled too — self-contained browser SDK.)
    noExternal: [
      'assert',
      'ethers',
      '@railgun-community/circomlibjs',
      '@railgun-community/poseidon-hash-wasm',
      '@railgun-community/curve25519-scalarmult-wasm',
      '@noble/ciphers',
      '@noble/ed25519',
      '@noble/hashes',
      '@scure/base',
      'ethereum-cryptography',
      'buffer-xor',
      'fast-text-encoding',
      'msgpack-lite',
    ],
    // `assert: false` → the plugin defers to the real (callable) `assert` npm package; its built-in
    // shim exports a non-callable namespace, but ffjavascript calls `assert(cond)` as a function.
    esbuildPlugins: [inlineWasmUrl, polyfillNode({ polyfills: { crypto: true, assert: false } })],
  },
  // ── Node CJS ─────────────────────────────────────────────────────────────
  // Relayer + tests: real Node builtins, deps left external (deduped by the consumer / Node resolver). Also
  // code-split (one engine copy across entries), and emits `.d.cts` types for CommonJS TypeScript consumers.
  {
    entry,
    format: ['cjs'],
    platform: 'node',
    dts: true,
    clean: false,
    splitting: true,
    sourcemap: true,
    target: 'es2022',
    external: ['ethers', 'snarkjs', 'msgpack-lite'],
  },
])
