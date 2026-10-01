// ABOUTME: Tests scripts/check-vendor-divergence.mjs (SPEC §3.4) against temp vendor/upstream trees — every
// ABOUTME: vendored file that differs from upstream (or is new) must carry a one-line DIVERGES FROM UPSTREAM marker.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/check-vendor-divergence.mjs', import.meta.url));

let root: string;
const write = (path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

// Run the check offline against the temp trees; returns its exit code and combined output.
function check(): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [SCRIPT, '--vendor', join(root, 'vendor'), '--upstream', join(root, 'upstream')], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, output: e.stdout + e.stderr };
  }
}

describe('check-vendor-divergence (SPEC §3.4)', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vendor-divergence-'));
    write('upstream/src/utils/same.ts', 'export const a = 1;\n');
    write('vendor/src/utils/same.ts', 'export const a = 1;\n');
    write('upstream/src/note/changed.ts', 'export const b = 1;\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes when every modified file carries the marker', () => {
    write('vendor/src/note/changed.ts', '// DIVERGES FROM UPSTREAM: b is 2.\nexport const b = 2;\n');
    const result = check();
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/1 diverging file.*all marked/i);
  });

  it('fails on a modified file without the marker, naming it', () => {
    // WHY: a future re-vendor re-applies only the files marked as diverging, so an unmarked change is
    // silently lost when upstream is copied over it.
    write('vendor/src/note/changed.ts', 'export const b = 2;\n');
    const result = check();
    expect(result.code).toBe(1);
    expect(result.output).toContain('modified: note/changed.ts');
  });

  it('fails on a file that is not in upstream at all (added) without the marker', () => {
    write('vendor/src/note/changed.ts', '// DIVERGES FROM UPSTREAM: b is 2.\nexport const b = 2;\n');
    write('vendor/src/merkletree/lifted.ts', 'export const c = 3;\n');
    const result = check();
    expect(result.code).toBe(1);
    expect(result.output).toContain('added: merkletree/lifted.ts');
  });

  it('does not count a marker split across two lines', () => {
    write('vendor/src/note/changed.ts', '// ABOUTME: this DIVERGES FROM\n// ABOUTME: UPSTREAM in b.\nexport const b = 2;\n');
    const result = check();
    expect(result.code).toBe(1);
    expect(result.output).toContain('modified: note/changed.ts');
  });
});
