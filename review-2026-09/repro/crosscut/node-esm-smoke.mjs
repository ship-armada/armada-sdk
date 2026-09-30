// ABOUTME: Node ESM smoke test of the browser-targeted dist: load, create an SDK, round-trip a viewing key.
// ABOUTME: Shows Node ESM consumers work despite the missing node export condition.
// Scratch: Node ESM consumer gets the browser-targeted dist/index.js (no "node" export condition).
import * as root from '../../../dist/index.js';
const sdk = await root.createArmadaSdk({
  pool: { chainId: 31337, poolAddress: '0x' + '11'.repeat(20), deployBlock: 1, usdcAddress: '0x' + '22'.repeat(20) },
  rpc: { urls: ['http://127.0.0.1:1'] },
  storage: new root.MemoryStorageAdapter(),
  prover: { prove: async () => { throw new Error('x'); }, close: async () => {} },
  artifacts: { resolve: async () => { throw new Error('x'); } },
});
const seed = new Uint8Array(32).fill(7);
const w = await sdk.wallet.fromRootSecret(seed, { creationBlock: 1 });
const svk = w.shareViewingKey();
const vo = await sdk.wallet.viewOnlyFromViewingKey(svk, { creationBlock: 1 });
console.log('addr match via ESM dist in Node:', w.shieldedAddress === vo.shieldedAddress);
const ks = await root.deriveKeyset(seed);
await sdk.close();
