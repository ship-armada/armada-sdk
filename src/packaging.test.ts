// ABOUTME: Guards the built package layout (#129, #116) — every entry shares one engine copy (ESM + CJS), the
// ABOUTME: prover worker stays lean, browser chunks import no Node built-ins, and the exports map types every condition.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { distAvailable } from '../test/dist-guard';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  exports: Record<string, Record<string, Record<string, string>>>;
};

// The ESM files an entry loads: the entry itself plus every chunk it statically imports, transitively.
function esmGraph(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(file, 'utf8');
    for (const m of code.matchAll(/(?:^|[;\n])\s*(?:import|export)\s[^'"]*?from\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      visit(resolve(dirname(file), m[1]!));
    }
    for (const m of code.matchAll(/(?:^|[;\n])\s*import\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      visit(resolve(dirname(file), m[1]!));
    }
  };
  visit(join(DIST, entry));
  return [...seen];
}

const BROWSER_ENTRIES = ['index.js', 'core/index.js', 'wallet/index.js', 'prover/index.js', 'prover/worker.js'];

describe('one engine copy across entries (#116)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ESM: the root, /core, /wallet and /prover share module state and classes', async (ctx) => {
    if (!distAvailable(ctx)) return;
    // The ESM build targets browsers: its bundled `process` polyfill reads `navigator.language` on load.
    // Node 21+ defines `navigator`; on older Node, supply the one browser global it needs.
    if ((globalThis as { navigator?: unknown }).navigator === undefined) vi.stubGlobal('navigator', { language: 'en-US' });
    const load = (p: string): Promise<Record<string, unknown>> => import(pathToFileURL(join(DIST, p)).href);
    const [root, core, wallet, prover] = await Promise.all(['index.js', 'core/index.js', 'wallet/index.js', 'prover/index.js'].map(load));
    expect(core!.initPoseidonPromise).toBe(root!.initPoseidonPromise);
    expect(core!.getTokenDataHash).toBe(root!.getTokenDataHash);
    expect(wallet!.LocalSigner).toBe(root!.LocalSigner);
    expect(prover!.createWorkerProver).toBe(root!.createWorkerProver);
    // WHY: with a copy per entry, an error thrown by /wallet failed `instanceof` against the root's classes.
    const err = await (wallet!.deriveKeyset as (s: Uint8Array) => Promise<unknown>)(new Uint8Array(3)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(root!.ArmadaError as new () => Error);
  }, 60_000);

  it('CJS: the root, /core, /wallet and /prover share module state and classes', async (ctx) => {
    if (!distAvailable(ctx)) return;
    const req = createRequire(import.meta.url);
    const load = (p: string): Record<string, unknown> => req(join(DIST, p)) as Record<string, unknown>;
    const [root, core, wallet, prover] = ['index.cjs', 'core/index.cjs', 'wallet/index.cjs', 'prover/index.cjs'].map(load);
    expect(core!.initPoseidonPromise).toBe(root!.initPoseidonPromise);
    expect(wallet!.LocalSigner).toBe(root!.LocalSigner);
    expect(prover!.createWorkerProver).toBe(root!.createWorkerProver);
    const err = await (wallet!.deriveKeyset as (s: Uint8Array) => Promise<unknown>)(new Uint8Array(3)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(root!.ArmadaError as new () => Error);
  });
});

describe('browser chunks', () => {
  it('the prover worker loads no engine or inlined WASM', (ctx) => {
    // WHY: a browser Worker loads @armada/sdk/prover/worker; pulling the shared engine chunk (13 MB of
    // inlined WASM) into it would make every proof start with a multi-MB parse.
    if (!distAvailable(ctx)) return;
    const graph = esmGraph('prover/worker.js');
    for (const file of graph) {
      expect(readFileSync(file, 'utf8'), `${file} is in the worker graph`).not.toContain('data:application/wasm');
    }
    const bytes = graph.reduce((n, f) => n + readFileSync(f).length, 0);
    expect(bytes).toBeLessThan(500_000);
  });

  it('no chunk reachable from a browser entry imports a Node built-in', (ctx) => {
    // WHY: a bare `import("fs/promises")` in the browser ESM fails esbuild browser builds and makes Vite
    // warn about externalised modules. Node-only code lives behind the `@armada/sdk/node` entry.
    if (!distAvailable(ctx)) return;
    const builtin = /(?:from\s*|import\(\s*|require\(\s*)["'](node:[^"']+|fs|fs\/promises|path|os|child_process|worker_threads|module)["']/;
    for (const entry of BROWSER_ENTRIES) {
      for (const file of esmGraph(entry)) {
        const hit = readFileSync(file, 'utf8').match(builtin);
        expect(hit?.[0], `${file} (reachable from ${entry}) imports a Node built-in`).toBeUndefined();
      }
    }
  });
});

describe('exports map', () => {
  it('lists exactly the shipped entries, with no /payments or /ops placeholders', () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './core', './node', './prover', './prover/worker', './wallet']);
  });

  it('gives every import/require condition its own types file, and every target exists', (ctx) => {
    // WHY: one ESM `.d.ts` per subpath made CommonJS TypeScript consumers (node16/nodenext) fail with TS1479.
    if (!distAvailable(ctx)) return;
    for (const [subpath, conditions] of Object.entries(pkg.exports)) {
      expect(conditions.import?.types, `${subpath} import types`).toMatch(/\.d\.ts$/);
      expect(conditions.require?.types, `${subpath} require types`).toMatch(/\.d\.cts$/);
      for (const target of [conditions.import!.types!, conditions.import!.default!, conditions.require!.types!, conditions.require!.default!]) {
        expect(existsSync(join(ROOT, target)), `${subpath} → ${target}`).toBe(true);
      }
    }
  });

  it('typechecks a CommonJS consumer under moduleResolution node16', (ctx) => {
    if (!distAvailable(ctx)) return;
    const fixture = join(ROOT, 'test/fixtures/cjs-consumer/consumer.cts');
    const tsc = join(ROOT, 'node_modules/typescript/bin/tsc');
    const args = [tsc, '--noEmit', '--strict', '--module', 'node16', '--moduleResolution', 'node16', '--skipLibCheck', fixture];
    let output = '';
    try {
      execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      output = (err as { stdout: string }).stdout;
    }
    expect(output).toBe('');
  }, 60_000);
});
