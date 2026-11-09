// DIVERGES FROM UPSTREAM: imports circomlibjs' babyjub module directly, not its index (see utils/poseidon.ts).
import * as babyjub from '@railgun-community/circomlibjs/src/babyjub';

export class Babyjubjub {
  static packPoint = babyjub.packPoint;

  static unpackPoint = babyjub.unpackPoint;
}
