// ABOUTME: Tests for the error model (F4, #117 epic #123) — every SDK error has a distinct, listed code; isArmadaError
// ABOUTME: matches by code across SDK copies; a code rebuilds its class; and no untyped `throw new Error` is left in src.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as errors from './errors';
import {
  ArmadaError,
  AbortedError,
  InvalidRequestError,
  RpcError,
  ERROR_CODES,
  isArmadaError,
  type ErrorCode,
  type ArmadaErrorByCode,
} from './errors';
import { armadaErrorFromCode } from './error-transport';

// Every concrete error class the module exports.
const classes = (Object.values(errors) as unknown[]).filter(
  (v): v is new (message: string, options: { status: number }) => ArmadaError =>
    typeof v === 'function' && (v as { prototype?: unknown }).prototype instanceof ArmadaError,
);

describe('the error model (F4)', () => {
  it('gives every error class a distinct code, and lists every code in ERROR_CODES', () => {
    // An options object satisfies the classes whose constructors need more than a message (status, cause).
    const codes = classes.map((C) => new C('x', { status: 0 }).code);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual([...ERROR_CODES].sort());
  });

  it('isArmadaError matches by code — also for an error from another copy of the SDK — and can require a code', () => {
    // WHY: `instanceof` is false when the SDK is loaded twice (ESM + CJS, or two bundled copies); the code is stable.
    const fromAnotherCopy = Object.assign(new Error('aborted elsewhere'), { code: 'ABORTED' });
    expect(isArmadaError(new AbortedError('x'))).toBe(true);
    expect(isArmadaError(fromAnotherCopy)).toBe(true);
    expect(isArmadaError(fromAnotherCopy, 'ABORTED')).toBe(true);
    expect(isArmadaError(fromAnotherCopy, 'ROOT_MISMATCH')).toBe(false);
    // An ethers or other library error isn't an SDK error, whatever its code field holds.
    expect(isArmadaError(Object.assign(new Error('down'), { code: 'NETWORK_ERROR' }))).toBe(false);
    expect(isArmadaError(new Error('plain'))).toBe(false);
    expect(isArmadaError(undefined)).toBe(false);
  });

  it('narrows to the code\'s class, so its own fields are typed', () => {
    const err: unknown = new RpcError('getLogs', Object.assign(new Error('down'), { code: 'TIMEOUT' }));
    // Compiles only because isArmadaError(err, 'RPC') narrows `err` to RpcError.
    expect(isArmadaError(err, 'RPC') && err.transport).toBe(true);
  });

  it('lists a class for every code', () => {
    // Compile-time: every ErrorCode has an entry in ArmadaErrorByCode, and nothing else does.
    const exact: Record<ErrorCode, ArmadaError> = {} as ArmadaErrorByCode;
    const back: ArmadaErrorByCode = {} as Record<ErrorCode, never>;
    expect([exact, back]).toHaveLength(2);
  });

  it('rebuilds an error of the right class from its code (how typed errors cross the prover worker boundary)', () => {
    const rebuilt = armadaErrorFromCode('INVALID_REQUEST', 'bad request');
    expect(rebuilt).toBeInstanceOf(InvalidRequestError);
    expect(rebuilt?.message).toBe('bad request');
    expect(armadaErrorFromCode('NOT_A_CODE', 'x')).toBeUndefined();
  });

  it('leaves no untyped `throw new Error(` / `reject(new Error(` in the SDK source', () => {
    // WHY: every error that reaches a consumer must carry a stable `code` (SPEC §8); a bare Error has none.
    const root = join(dirname(fileURLToPath(import.meta.url)));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
          readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
            if (/(throw|reject\()\s*new (Type)?Error\(/.test(line)) offenders.push(`${path.slice(root.length + 1)}:${i + 1}`);
          });
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
