// ABOUTME: Node StorageAdapter (SPEC §4.3) over an injected abstract-level DB (classic-level in prod,
// ABOUTME: memory-level in tests). The consumer brings the DB, so the SDK stays browser-safe + dep-free.

import { StorageConflictError } from '../errors';
import type { StorageAdapter, StorageNamespace } from './index';
import { NAMESPACE_KEY, isPreserved, encodeNamespace, bytesEqual } from './namespace';

/**
 * The minimal `abstract-level` surface `LevelStorageAdapter` needs. `classic-level` (Node LevelDB),
 * `memory-level`, and any other abstract-level database satisfy it. The SDK does NOT depend on a level
 * package — the consumer constructs the DB (bringing the native binary) and injects it, keeping the SDK
 * browser-safe and free of native deps. Construct with binary value encoding, e.g.
 * `new ClassicLevel(path, { keyEncoding: 'utf8', valueEncoding: 'view' })`.
 */
export interface AbstractLevelLike {
  readonly status: string; // 'open' | 'closed' | 'opening' | 'closing'
  open(): Promise<void>;
  close(): Promise<void>;
  get(key: string, options?: object): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array, options?: object): Promise<void>;
  del(key: string, options?: object): Promise<void>;
  iterator(options?: object): { all(): Promise<[string, Uint8Array][]> };
}

// Force binary keys/values per call, so the adapter works regardless of the DB's default encoding.
const ENC = { keyEncoding: 'utf8', valueEncoding: 'view' } as const;

/** Node-persistent StorageAdapter over an abstract-level DB, with the shared namespace/reset semantics. */
export class LevelStorageAdapter implements StorageAdapter {
  constructor(private readonly db: AbstractLevelLike) {}

  async open(namespace: StorageNamespace): Promise<{ reset: boolean }> {
    if (this.db.status !== 'open') {
      try {
        await this.db.open();
      } catch (err) {
        // classic-level locks its on-disk directory; a second process opening it throws a LEVEL_LOCKED
        // error. Surface advisory-lock conflicts as the typed error (SPEC §4.3) rather than an opaque one.
        const code = (err as { code?: string }).code ?? '';
        const message = err instanceof Error ? err.message : String(err);
        if (/lock/i.test(code) || /lock/i.test(message)) {
          throw new StorageConflictError(`LevelStorageAdapter: database is locked by another process (${code || message})`);
        }
        throw err;
      }
    }
    const nsBytes = encodeNamespace(namespace);
    const previous = await this.get(NAMESPACE_KEY);
    const reset = previous !== undefined && !bytesEqual(previous, nsBytes);
    if (reset) await this.resetChainState();
    await this.put(NAMESPACE_KEY, nsBytes);
    return { reset };
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const v = await this.db.get(key, ENC);
    return v === undefined ? undefined : new Uint8Array(v);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.db.put(key, value, ENC);
  }

  async del(key: string): Promise<void> {
    await this.db.del(key, ENC);
  }

  async *list(prefix: string): AsyncIterable<{ key: string; value: Uint8Array }> {
    // Half-open range [prefix, prefix+￿]; keys are ASCII paths (chain/ identity/ durable/), so the
    // sentinel can't clip a real key (same convention as the IndexedDB adapter).
    const entries = await this.db.iterator({ gte: prefix, lte: `${prefix}￿`, ...ENC }).all();
    for (const [key, value] of entries) yield { key, value: new Uint8Array(value) };
  }

  async resetChainState(): Promise<void> {
    const entries = await this.db.iterator(ENC).all();
    for (const [key] of entries) {
      if (!isPreserved(key)) await this.db.del(key, ENC);
    }
  }

  async close(): Promise<void> {
    if (this.db.status === 'open') await this.db.close();
  }
}
