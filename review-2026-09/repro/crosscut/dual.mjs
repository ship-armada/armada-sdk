// ABOUTME: Dual-entry identity check against the current dist: root vs /core vs /wallet (XC-1).
// ABOUTME: Prints false for every shared class/function/state identity when splitting is off.
// Scratch: import root + /core + /wallet ESM bundles and compare module-level identity.
import * as root from '../../../dist/index.js';
import * as core from '../../../dist/core/index.js';
import * as wallet from '../../../dist/wallet/index.js';
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
