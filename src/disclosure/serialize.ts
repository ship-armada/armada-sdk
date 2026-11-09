// ABOUTME: Disclosure package serialization (ADR-0020) — JSON is the wire format; every field is already
// ABOUTME: a string or a number, so (de)serialization is JSON plus a structural validation on parse.

import { InvalidRequestError } from '../errors';
import { DISCLOSURE_PACKAGE_VERSION, type DisclosurePackage } from './types';

/** Serialize a package to its JSON wire form (pretty-printed for a readable audit record). */
export function serializeDisclosurePackage(pkg: DisclosurePackage): string {
  return JSON.stringify(pkg, null, 2);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parse and validate a disclosure package from JSON. Rejects an unknown version or a missing top-level
 * section with a typed `InvalidRequestError`; deep field checks are the checker's job (every field is
 * re-derived and compared there), so parsing only guards the shape the checker iterates.
 */
export function parseDisclosurePackage(json: string): DisclosurePackage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new InvalidRequestError('parseDisclosurePackage: invalid JSON', { cause: err });
  }
  if (!isObject(parsed)) {
    throw new InvalidRequestError('parseDisclosurePackage: not an object');
  }
  if (parsed.version !== DISCLOSURE_PACKAGE_VERSION) {
    throw new InvalidRequestError(`parseDisclosurePackage: unsupported version ${String(parsed.version)}`);
  }
  for (const key of ['domain', 'statement'] as const) {
    if (!isObject(parsed[key])) {
      throw new InvalidRequestError(`parseDisclosurePackage: missing "${key}"`);
    }
  }
  for (const key of ['endpointSignatures', 'openings', 'proofs', 'hops'] as const) {
    if (!Array.isArray(parsed[key])) {
      throw new InvalidRequestError(`parseDisclosurePackage: "${key}" must be an array`);
    }
  }
  return parsed as unknown as DisclosurePackage;
}
