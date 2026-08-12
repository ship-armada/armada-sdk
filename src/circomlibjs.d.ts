// ABOUTME: Ambient types for the Baby Jubjub helpers of @railgun-community/circomlibjs (ships no types).
// ABOUTME: Points are [x, y] bigint pairs in this build; only the members the SDK uses are declared.
declare module '@railgun-community/circomlibjs' {
  export const babyjub: {
    inCurve(point: [bigint, bigint]): boolean;
    inSubgroup(point: [bigint, bigint]): boolean;
    packPoint(point: [bigint, bigint]): Uint8Array;
    unpackPoint(buf: Uint8Array): [bigint, bigint] | null;
    readonly Base8: [bigint, bigint];
    readonly order: bigint;
    readonly subOrder: bigint;
  };
}
