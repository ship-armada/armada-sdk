// ABOUTME: EventSource implementations (SPEC §4.4) — RpcEventSource (getLogs → decode, the source of
// ABOUTME: truth + verification fallback). IndexerEventSource (native quick-sync fast path) lives alongside.

import { fetchLogsRanged, type GetLogsFn } from './ranged-fetch';
import { decodePoolEvents, type ParsedPoolLog } from './event-decoder';
import { parseQuickSync } from './quick-sync-wire';
import { IndexerHttpError } from '../errors';
import type { EventBatch, EventSource } from './index';

/**
 * Default source: ranged `getLogs` over `[fromBlock, toBlock]`, decoded to the native event shape.
 * Always covers the full requested range (`syncedThroughBlock === toBlock`), so it is both the
 * standalone sync path and the tail/verification fallback for the indexer source.
 */
export class RpcEventSource implements EventSource {
  constructor(
    private readonly getLogs: GetLogsFn<ParsedPoolLog>,
    private readonly maxRange?: number,
  ) {}

  async getEvents(
    fromBlock: number,
    toBlock: number,
    onProgress?: (coveredThroughBlock: number) => void,
  ): Promise<EventBatch> {
    const opts = {
      fromBlock,
      toBlock,
      ...(this.maxRange !== undefined ? { maxRange: this.maxRange } : {}),
      ...(onProgress !== undefined ? { onProgress } : {}),
    };
    const parsed = await fetchLogsRanged(this.getLogs, opts);
    return { events: decodePoolEvents(parsed), syncedThroughBlock: toBlock };
  }
}

export interface IndexerEventSourceOptions {
  /** Base URL of the indexer serving the native quick-sync API (e.g. the relayer-v2 watcher). */
  readonly baseUrl: string;
  /** Hub chain id — path segment of `/v2/quick-sync/:chainId`. */
  readonly chainId: number;
  /** Injected fetch (defaults to the global). */
  readonly fetchFn?: typeof fetch;
}

/**
 * Native quick-sync fast path: fetch pre-indexed events from `{baseUrl}/v2/quick-sync/{chainId}` and
 * validate them via `parseQuickSync`. Reports the indexer's `syncedThroughBlock` so the caller
 * RPC-covers any tail past it. Batches from here are NOT yet trusted — the caller must verify the
 * resulting tree against the on-chain root before acceptance (SPEC §4.4 decision #3).
 */
export class IndexerEventSource implements EventSource {
  private readonly baseUrl: string;
  private readonly chainId: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: IndexerEventSourceOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.chainId = options.chainId;
    // Wrap the fetch — default OR injected — so `this.fetchFn(url)` (a method call) never runs the
    // underlying fetch with `this === this instance`. Browser `fetch` is a Web IDL operation that
    // brand-checks its receiver and throws `Illegal invocation` for a non-global `this`; wrapping the
    // injected fn too keeps a consumer passing a bare `window.fetch` from reintroducing the bug. The
    // default branch resolves the global at call time, so it survives a later reassignment of fetch.
    const injected = options.fetchFn;
    this.fetchFn = injected
      ? (...args: Parameters<typeof fetch>) => injected(...args)
      : (...args: Parameters<typeof fetch>) => fetch(...args);
  }

  async getEvents(
    fromBlock: number,
    toBlock: number,
    onProgress?: (coveredThroughBlock: number) => void,
  ): Promise<EventBatch> {
    const url = `${this.baseUrl}/v2/quick-sync/${this.chainId}?fromBlock=${fromBlock}&toBlock=${toBlock}`;
    const res = await this.fetchFn(url);
    if (!res.ok) throw new IndexerHttpError(`quick-sync: indexer responded ${res.status} for ${url}`, { status: res.status });
    const { events, syncedThroughBlock } = parseQuickSync(await res.json());
    // Never claim past the requested window even if the indexer over-reports its head.
    const covered = Math.min(syncedThroughBlock, toBlock);
    // The indexer serves the whole window in one pre-indexed response — report the range it covered.
    onProgress?.(covered);
    return { events, syncedThroughBlock: covered };
  }
}
