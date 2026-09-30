// ABOUTME: Vite consumer entry importing @armada/sdk — shows the fs/promises + path externalization warnings (XC-2).
// ABOUTME: Build with vite build from this directory.
import { createArmadaSdk } from '../../../../dist/index.js';
console.log(typeof createArmadaSdk);
