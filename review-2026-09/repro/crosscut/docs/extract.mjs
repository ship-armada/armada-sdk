// ABOUTME: Extracts every ts code sample from docs/guide/*.md into gen/ for typechecking against src (XC-7).
// ABOUTME: Run it, then tsc -p review-2026-09/repro/crosscut/docs to check the docs compile.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const root = '/Users/ikay/conductor/workspaces/armada-sdk/muscat';
const out = `${root}/.context/repro/crosscut/docs/gen`;
import { mkdirSync } from 'node:fs'; mkdirSync(out, { recursive: true });
const prelude = `import * as SDK from '../../../../../src/index';
declare const sdk: SDK.ArmadaSdk; declare const wallet: SDK.Wallet; declare const rootSecret: Uint8Array;
declare const mnemonic: string; declare const seed: Uint8Array; declare const shareableViewingKey: string;
declare const manifest: SDK.ArtifactManifest; declare const db: SDK.AbstractLevelLike; declare const request: any;
declare const plan: SDK.Plan; declare const plans: SDK.Plan[]; declare const feeQuote: SDK.FeeQuote; declare const txid: string;
declare const myBackend: any; declare const provider: any; declare const relayer: any; declare const handle: SDK.ProofHandle;
declare const recipient: string; declare const amount: bigint; declare const usdc: \`0x\${string}\`;
`;
for (const f of ['getting-started','wallets','adapters','syncing','transactions','security','index'].map(n=>`docs/guide/${n}.md`)) {
  const md = readFileSync(`${root}/${f}`, 'utf8');
  const re = /```ts\n([\s\S]*?)```/g; let m; let i = 0;
  while ((m = re.exec(md))) {
    const line = md.slice(0, m.index).split('\n').length;
    let body = m[1].replace(/from '@armada\/sdk'/g, "from '../../../../../src/index'");
    const imports = [...body.matchAll(/^import[\s\S]*?;\n/gm)].map(x=>x[0]).join('');
    body = body.replace(/^import[\s\S]*?;\n/gm, '');
    const name = `${f.split('/').pop().replace('.md','')}_L${line}.ts`;
    writeFileSync(`${out}/${name}`, `${imports}${prelude}export async function __f() {\n${body}\n}\n`);
    i++;
  }
}
