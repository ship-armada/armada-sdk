# Security notes

## Dependency advisories (`npm audit`)

A consumer's `npm audit` inherits the SDK's runtime dependency advisories. This is the triage, so a
security review doesn't have to redo it. Re-run it when dependencies change.

**Triaged 2026-10-01** with `npm audit --omit=dev`: 56 advisories (3 critical, 9 high, 31 moderate,
13 low). None reaches the code paths the SDK runs.

| Advisories | Comes in through | Why it doesn't apply |
|---|---|---|
| All 3 criticals (`tar`, `request`, `form-data`) and most highs (`web3`, `web3-bzz`, `swarm-js`, `eth-lib`, `ws`) | `@railgun-community/circomlibjs` → `web3@1.10.4` | circomlibjs uses `web3` only in its own tests and contract generators. No `web3` code is in the SDK's bundle. |
| `bfj`, `jsonpath`, `underscore` (high) | `snarkjs` → `bfj` | snarkjs's file-based JSON I/O (its CLI and file loaders). The SDK passes artifacts to snarkjs as in-memory bytes. |
| `brace-expansion` (high) | `snarkjs` → `ejs` → `jake` → `minimatch` | snarkjs's CLI templating (e.g. exporting a Solidity verifier), which the SDK never calls. |
| `bn.js <4.12.3` (moderate, DoS) | `circomlibjs` → `web3-utils` → `number-to-bn` / `ethjs-unit` | The only advisory-carrying code that is in the bundle. circomlibjs's `eddsa` module requires `mimc7` / `mimcsponge`, which run `web3-utils` once at load to derive their round constants from fixed seeds. It never sees input, and the SDK never calls MiMC. The SDK imports circomlibjs's modules directly, not its index, so the contract generators aren't bundled. |

How this was checked:

- `npm audit --omit=dev --json` for the advisories, and `npm ls --omit=dev <package>` for the
  dependency path of each one.
- The `// node_modules/<package>` markers in the built `dist/index.js` for what is actually bundled.

Longer-term options, neither done yet:

- Vendor or extract the few circomlibjs modules the SDK uses, which drops `web3` entirely. (Importing the modules
  directly already keeps the contract generators out of the bundle; `eddsa` still pulls in MiMC and `web3-utils`.)
- Ask upstream to move `web3` to circomlibjs's `devDependencies`.
