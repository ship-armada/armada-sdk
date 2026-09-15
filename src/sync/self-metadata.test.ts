// ABOUTME: Tests for the self-metadata codec (issue #88 lever 3) — round-trip + distinguishing an SDK
// ABOUTME: metadata blob from a plain user memo so recovery never misreads a user's note.

import { describe, it, expect } from 'vitest';
import { encodeSelfMetadata, decodeSelfMetadata } from './self-metadata';

describe('self-metadata codec (issue #88)', () => {
  it('round-trips an arbitrary payload', () => {
    const payload = 'fee=20000;mode=gasless;cacheId=abc123';
    expect(decodeSelfMetadata(encodeSelfMetadata(payload))).toBe(payload);
  });

  it('round-trips an empty payload (marker present, payload empty)', () => {
    expect(decodeSelfMetadata(encodeSelfMetadata(''))).toBe('');
  });

  it('returns undefined for a plain user memo (no marker)', () => {
    expect(decodeSelfMetadata('thanks for lunch')).toBeUndefined();
    // A user memo that merely mentions the tag text (without the leading NUL marker) is not ours.
    expect(decodeSelfMetadata('armeta:v1:not really')).toBeUndefined();
  });

  it('returns undefined for an absent memo', () => {
    expect(decodeSelfMetadata(undefined)).toBeUndefined();
  });
});
