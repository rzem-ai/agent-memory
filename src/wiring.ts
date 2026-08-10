/**
 * Dependency wiring shared by both entrypoints: config -> db pool, embedding
 * clients, repositories, recall services, and the ServerDeps bundle the
 * per-request factory closes over.
 */

import { createDb } from "./db/pool.js";
import { createEmbeddings } from "./embeddings/index.js";
import { createThoughtsRepository } from "./repositories/thoughts.js";
import { createKvRepository } from "./repositories/kv.js";
import { createVaultReadRepository } from "./repositories/vault.js";
import { createVaultRecall } from "./services/recall.js";
import type { AppConfig } from "./config/index.js";
import type { Logger } from "./observability/logger.js";
import type { ServerDeps } from "./server.js";

export interface Wired {
  serverDeps: ServerDeps;
  close(): Promise<void>;
}

export function buildDeps(config: AppConfig, log: Logger): Wired {
  const db = createDb(config.database);
  const embeddings = createEmbeddings(config.embeddings);

  const search = {
    defaultMode: config.search.default_mode,
    recencyDecayDays: config.search.recency_decay_days,
    recencyFloor: config.search.recency_floor,
  };

  const thoughts = createThoughtsRepository({
    query: db.query,
    getEmbedding: (text) => embeddings.thoughts.embed(text),
    search,
  });
  const kv = createKvRepository(db.query);
  const vaultRepo = createVaultReadRepository(db.vault);
  const vault = createVaultRecall({
    repo: vaultRepo,
    documentEmbeddings: embeddings.documents,
    ...(config.vault.dir ? { vaultDir: config.vault.dir } : {}),
  });

  return {
    serverDeps: { thoughts, kv, vault, search, log },
    close: () => db.close(),
  };
}
