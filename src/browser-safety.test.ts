// ABOUTME: Guards the browser ESM build against regressions that only surface in a browser bundler —
// ABOUTME: esbuild dynamic-require shims + unresolved wasm URLs. Both are fatal at runtime yet invisible to Node.

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { distAvailable } from '../test/dist-guard'

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')

// Every browser ESM file: the entries plus the shared chunks code splitting emits (the engine and its inlined
// wasm live in a shared chunk, not in dist/index.js). The Node-only entry is excluded.
function browserEsmFiles(dir = DIST): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node' ? [] : browserEsmFiles(path)
    return e.name.endsWith('.js') ? [path] : []
  })
}

/**
 * WHY: every consumer until the interface was Node, so the build shipped browser-fatal artifacts that
 * Node tolerated — CJS `require()`s wrapped in esbuild `__require("x")` shims ("Dynamic require of x is
 * not supported") and wasm-pack `new URL('x_bg.wasm', import.meta.url)` fetches that 404 to index.html
 * ("expected magic word"). This asserts the browser ESM has neither, so the class can't regress silently.
 */
describe('browser ESM safety (dist/**/*.js)', () => {
  it('ships no dynamic-require shims and inlines its wasm', (ctx) => {
    // Guards the BUILT output (skipped on an unbuilt local tree; required in CI).
    if (!distAvailable(ctx)) return
    const code = browserEsmFiles().map((f) => readFileSync(f, 'utf8')).join('\n')

    // (1) Zero dynamic-require shims — the browser build must resolve every CJS `require`.
    const dynamicRequires = [...new Set(code.match(/__require\d*\("[^"]+"\)/g) ?? [])]
    expect(dynamicRequires, `browser ESM has dynamic requires: ${dynamicRequires.join(', ')}`).toEqual([])

    // (2) ZK wasm inlined as a data URL, with no sibling `.wasm` asset reference left to 404.
    expect(code, 'ZK wasm must be inlined as a data URL').toContain('data:application/wasm;base64')
    expect(/[a-z0-9_]+_bg\.wasm['"]/.test(code), 'no unresolved *_bg.wasm file reference').toBe(false)
  })
})
