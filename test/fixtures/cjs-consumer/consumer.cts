// ABOUTME: A CommonJS TypeScript consumer (moduleResolution node16), typechecked by src/packaging.test.ts —
// ABOUTME: guards that every subpath resolves its `.d.cts` types under the `require` condition (#129, XC-3).

import { createArmadaSdk, ArmadaError, decodeAddress } from '@armada/sdk';
import { deriveKeyset } from '@armada/sdk/wallet';
import { getTokenDataHash } from '@armada/sdk/core';
import { createWorkerProver } from '@armada/sdk/prover';
import { FilesystemArtifactSource } from '@armada/sdk/node';

export const used = [createArmadaSdk, ArmadaError, decodeAddress, deriveKeyset, getTokenDataHash, createWorkerProver, FilesystemArtifactSource];
