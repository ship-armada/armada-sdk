// ABOUTME: Ambient types for the Baby Jubjub module of @railgun-community/circomlibjs (ships no types), imported directly.
// ABOUTME: Points are [x, y] bigint pairs in this build; only the members the SDK uses are declared.
declare module '@railgun-community/circomlibjs/src/babyjub' {
  export function inCurve(point: [bigint, bigint]): boolean;
  export function inSubgroup(point: [bigint, bigint]): boolean;
  export function packPoint(point: [bigint, bigint]): Uint8Array;
  export function unpackPoint(buf: Uint8Array): [bigint, bigint] | null;
  export const Base8: [bigint, bigint];
  export const order: bigint;
  export const subOrder: bigint;
}
