// ABOUTME: Self-metadata codec (issue #88 lever 3) — tags a caller blob so it can be written into the
// ABOUTME: change note's memo (self-owned) and recognized on recovery, distinct from a user's transfer memo.

// Leading NUL (constructed, not a source literal) makes the marker impossible in a human-typed transfer
// memo, so recovery never mistakes a user's note for SDK metadata. Versioned so the format can evolve.
const SELF_META_PREFIX = `${String.fromCharCode(0)}armeta:v1:`;

/** Wrap a caller-provided metadata string for storage in a self-owned change-note memo. */
export function encodeSelfMetadata(payload: string): string {
  return `${SELF_META_PREFIX}${payload}`;
}

/**
 * Recover the caller metadata from a change note's memo, or `undefined` if the memo is absent or is a
 * normal (user) memo rather than an SDK self-metadata blob.
 */
export function decodeSelfMetadata(memo: string | undefined): string | undefined {
  if (memo === undefined || !memo.startsWith(SELF_META_PREFIX)) return undefined;
  return memo.slice(SELF_META_PREFIX.length);
}
