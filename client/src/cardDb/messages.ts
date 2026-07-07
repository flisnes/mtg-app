import type { CardDbArtifactMeta } from '@mtg/shared';

// Message contract between the main thread and the import worker. The worker
// downloads + decompresses (DecompressionStream) + bulk-imports into Dexie so
// the UI thread stays responsive during the ~14MB import (beta plan §3).

export interface ImportRequest {
  baseUrl: string;
  cardDbVersion: string;
  pricesUpdatedAt: string;
  oracle: CardDbArtifactMeta;
  printings: CardDbArtifactMeta;
}

export type ImportProgress =
  | { phase: 'download'; artifact: 'oracle' | 'printings'; loaded: number; total: number }
  | { phase: 'import'; artifact: 'oracle' | 'printings'; done: number; total: number };

export type WorkerResponse =
  | { type: 'progress'; progress: ImportProgress }
  | { type: 'done' }
  | { type: 'error'; message: string };
