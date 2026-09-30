// ABOUTME: Same identity check as dual.mjs, against the splitting:true build in dist-split/ (XC-1 fix check).
// ABOUTME: Build dist-split first with tsup.split.config.ts; every check should print true.
// Scratch: import root + /core + /wallet ESM bundles and compare module-level identity.
import * as root from './dist-split/index.js';
import * as core from './dist-split/core/index.js';
import * as wallet from './dist-split/wallet/index.js';
console.log('ChainType same object:', root.ChainType === core.ChainType);
console.log('initPoseidonPromise same:', root.initPoseidonPromise === core.initPoseidonPromise);
console.log('deriveKeyset same fn:', root.deriveKeyset === wallet.deriveKeyset);
console.log('LocalSigner same class:', root.LocalSigner === wallet.LocalSigner);
console.log('getTokenDataHash same fn:', root.getTokenDataHash === core.getTokenDataHash);
try { await wallet.deriveKeyset(new Uint8Array(3)); } catch (e) {
  console.log('wallet error instanceof root.InvalidKeyMaterialError:', e instanceof root.InvalidKeyMaterialError, 'code:', e.code);
}
// WalletInfo state: root's createTransferNote sets the ROOT copy; core's WalletInfo stays unset.
await root.initPoseidonPromise;
console.log('core WalletInfo.walletSource before:', core.WalletInfo.walletSource);
