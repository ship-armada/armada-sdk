// ABOUTME: Marks the compiled vendor dist as CommonJS so the ESM package (`type: module`) loads it
// ABOUTME: correctly. The vendor is emitted as CJS; core imports it across the ESM/CJS boundary.
import { writeFileSync } from 'node:fs';

writeFileSync(
  new URL('../vendor/railgun-engine/dist/package.json', import.meta.url),
  '{ "type": "commonjs" }\n',
);
