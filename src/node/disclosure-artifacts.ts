// ABOUTME: Disclosure artifact loader (ADR-0020, Node-only) — reads the compiled NullifierDisclosure.circom
// ABOUTME: artifacts from a local armada-circuits/build/disclosure directory, kept off the browser entries.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactSet } from '../prover/index';

/**
 * Load the compiled disclosure artifacts from a local directory (Node). The directory layout is
 * `armada-circuits/build/disclosure/`: `main_disclosure_js/main_disclosure.wasm`, `final.zkey`,
 * `vkey.json`. A browser caller supplies the `ArtifactSet` itself; this helper is Node-only, so it
 * lives on `@armada/sdk/node`.
 */
export async function loadDisclosureArtifacts(baseDir: string): Promise<ArtifactSet> {
  const [wasm, zkey, vkeyBytes] = await Promise.all([
    readFile(join(baseDir, 'main_disclosure_js', 'main_disclosure.wasm')),
    readFile(join(baseDir, 'final.zkey')),
    readFile(join(baseDir, 'vkey.json')),
  ]);
  const vkeyRaw = new Uint8Array(vkeyBytes);
  return {
    wasm: new Uint8Array(wasm),
    zkey: new Uint8Array(zkey),
    vkey: JSON.parse(new TextDecoder().decode(vkeyRaw)) as object,
    vkeyRaw,
  };
}
