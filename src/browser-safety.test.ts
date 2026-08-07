// ABOUTME: Guards the browser ESM build against regressions that only surface in a browser bundler —
// ABOUTME: esbuild dynamic-require shims + unresolved wasm URLs. Both are fatal at runtime yet invisible to Node.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const ESM = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/index.js')

/**
 * WHY: every consumer until the interface was Node, so the build shipped browser-fatal artifacts that
 * Node tolerated — CJS `require()`s wrapped in esbuild `__require("x")` shims ("Dynamic require of x is
 * not supported") and wasm-pack `new URL('x_bg.wasm', import.meta.url)` fetches that 404 to index.html
 * ("expected magic word"). This asserts the browser ESM has neither, so the class can't regress silently.
 */
describe('browser ESM safety (dist/index.js)', () => {
  it('ships no dynamic-require shims and inlines its wasm', (ctx) => {
    // Guards the BUILT output; on a fresh tree (pre-build) dist is absent — soft-skip (prepare/CI build first).
    if (!existsSync(ESM)) {
      ctx.skip()
      return
    }
    const code = readFileSync(ESM, 'utf8')

    // (1) Zero dynamic-require shims — the browser build must resolve every CJS `require`.
    const dynamicRequires = [...new Set(code.match(/__require\d*\("[^"]+"\)/g) ?? [])]
    expect(dynamicRequires, `browser ESM has dynamic requires: ${dynamicRequires.join(', ')}`).toEqual([])

    // (2) ZK wasm inlined as a data URL, with no sibling `.wasm` asset reference left to 404.
    expect(code, 'ZK wasm must be inlined as a data URL').toContain('data:application/wasm;base64')
    expect(/[a-z0-9_]+_bg\.wasm['"]/.test(code), 'no unresolved *_bg.wasm file reference').toBe(false)
  })
})
