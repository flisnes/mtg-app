import type { CardDbArtifactMeta } from '@mtg/shared';

// Message contract between the main thread and the import worker. The worker
// downloads + decompresses (DecompressionStream) + bulk-imports into Dexie so
// the UI thread stays responsive. It receives only the chunks that actually
// changed (plus the prices file when prices moved), not the whole card DB.

export interface ChunkTask {
  artifact: 'oracle' | 'printings';
  /** Id prefix this chunk covers (first two hex chars); also its delete range. */
  key: string;
  url: string;
  bytes: number;
  sha256: string;
  count: number;
}

export interface ImportRequest {
  baseUrl: string;
  /** Identity of the full card data set (manifest v2 dataVersion). */
  dataVersion: string;
  /** Scryfall bulk `updated_at`, for the About screen. */
  cardDbUpdatedAt: string;
  pricesUpdatedAt: string;
  chunks: ChunkTask[];
  /** Null when prices haven't changed since the installed set. */
  prices: CardDbArtifactMeta | null;
}

export type WorkerResponse =
  | { type: 'progress'; fraction: number; label: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
