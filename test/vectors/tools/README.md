# Nitro state-channel parity vectors

`../nitro-state-vectors.json` holds go-nitro channel-id, state-hash and
ECDSA-signer values. The armada-nitro contracts produce these values, not
armada-sdk. `src/disclosure/nitro.test.ts` recomputes them in TypeScript with
`src/disclosure/nitro.ts` and asserts they are byte-identical. This proves the
SDK's go-nitro primitives match the contracts.

`NitroVectors.s.sol` is the generator. It is a Foundry script. It imports the
armada-nitro contracts, so it runs inside an armada-nitro checkout, not in this
repo. The SDK test run (`npm test`) does not run Foundry and has no Foundry
dependency.

## Pinned source

- Repository: `ship-armada/armada-nitro`.
- Commit: `edc1de96ba81e674dabe3ff737756c261f9996d6`.
- Contracts: `src/nitro/libraries/NitroUtils.sol` (`getChannelId`, `hashState`,
  `prefixedHash`, `recoverSigner`) and `lib/exit-format/contracts/ExitFormat.sol`.

## How to regenerate

1. Check out armada-nitro at the pinned commit.
2. Copy this script into that checkout, under a path Foundry compiles (for
   example `script/`):

   ```
   cp test/vectors/tools/NitroVectors.s.sol <armada-nitro>/script/NitroVectors.s.sol
   ```

3. Run the script in the armada-nitro checkout:

   ```
   cd <armada-nitro>
   forge script script/NitroVectors.s.sol:NitroVectors
   ```

4. The script prints one line `VECTORS={...}`. Take the JSON after `VECTORS=`
   and place it as the single element of the `vectors` array in
   `../nitro-state-vectors.json`. Keep the `_provenance` block and update its
   `armada_nitro_commit` if you regenerate against a newer commit.

5. Rerun the parity test to confirm the SDK still matches:

   ```
   cd <armada-sdk>
   npx vitest run src/disclosure/nitro.test.ts
   ```

The script writes no files; it only logs the JSON. Do not commit it into
armada-nitro. Foundry stack-too-deep errors do not occur here because the
script keeps few local variables; `--via-ir` is not needed.
