// ABOUTME: tsup build config for @armada/sdk — a browser-first ESM build (self-contained, Node-builtin
// ABOUTME: polyfilled) + a Node CJS build (real builtins). Emits dist/{index,core,wallet,payments,ops}.

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
  'payments/index': 'src/payments/index.ts',
  'ops/index': 'src/ops/index.ts',
  // Lean prover entry — prover code + snarkjs only, NO vendored engine/core/wasm. A browser Web
  // Worker imports this (not the 13MB wasm-inlined root) so the worker chunk stays small + bundles fast.
  'prover/index': 'src/prover/index.ts',
}

export default defineConfig([
  // ── Browser ESM ──────────────────────────────────────────────────────────
  // The vendored Railgun engine is CJS; esbuild wraps every `require()` in a `__require` shim that
  // throws "Dynamic require … not supported" in a browser bundler. So the browser build must resolve
  // ALL requires: bundle the crypto deps + ethers, and POLYFILL Node builtins (crypto/buffer/…) with
  // browser shims. Goal: zero `__require` in the ESM output. snarkjs stays external — it's a lazy
  // `await import` in the prover (a real dynamic import Vite handles, never hit on the read path).
  {
    entry,
    format: ['esm'],
    platform: 'browser',
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    target: 'es2022',
    external: ['snarkjs'],
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
  // Relayer + tests: real Node builtins, deps left external (deduped by the consumer / Node resolver).
  {
    entry,
    format: ['cjs'],
    platform: 'node',
    dts: false,
    clean: false,
    splitting: false,
    sourcemap: true,
    target: 'es2022',
    external: ['ethers', 'snarkjs', 'msgpack-lite'],
  },
])
