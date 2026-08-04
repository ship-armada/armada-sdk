// ABOUTME: Sanity test for the Phase 0 differential vectors — asserts every fixture is present,
// ABOUTME: parses, and carries the engine-version stamp. The full core-vs-vector runner lands in Phase 1.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const EXPECTED = [
  'keyset-vectors.json',
  'poseidon-vectors.json',
  'npk-vectors.json',
  'commitment-vectors.json',
  'nullifier-vectors.json',
  'eddsa-spend-auth-vectors.json',
  'boundparams-hash-vectors.json',
  'merkle-vectors.json',
  'note-ciphertext-vectors.json',
  'transaction-struct-vectors.json',
];

describe('Phase 0 differential vectors', () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith('.json'));

  it('has all expected fixture files', () => {
    for (const name of EXPECTED) expect(files).toContain(name);
  });

  for (const name of EXPECTED) {
    it(`${name} parses and is stamped with the engine version`, () => {
      const parsed = JSON.parse(readFileSync(join(HERE, name), 'utf8'));
      expect(parsed.engineVersion).toBe('9.6.0');
      expect(parsed.capturedFromMainSha ?? parsed.base410Sha).toBeTruthy();
    });
  }
});
