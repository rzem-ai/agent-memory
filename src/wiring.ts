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
import { resolveSecret } from "./config/index.js";
import type { AppConfig } from "./config/index.js";
import type { Logger } from "./observability/logger.js";
import { createMesh, inertMesh } from "./observability/mesh.js";
import type { Mesh } from "./observability/mesh.js";
import type { ServerDeps } from "./server.js";

export interface Wired {
  serverDeps: ServerDeps;
  /** Where the entrypoints announce their surface once bound. */
  mesh: Mesh;
  close(): Promise<void>;
}

/** The observatory emitter, or the no-op when no [observatory] block is configured. */
function buildMesh(config: AppConfig, log: Logger): Mesh {
  const cfg = config.observatory;
  if (!cfg) return inertMesh;
  const token = resolveSecret(cfg.token);
  return createMesh(
    { url: cfg.url, name: cfg.name, role: cfg.role, ...(token ? { token } : {}) },
    { pid: process.pid, startedAt: new Date().toISOString(), peers: [] },
    { log },
  );
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
  const vaultRepo = createVaultReadRepository(db.vault, {
    ...(config.vault.default_owner ? { defaultOwner: config.vault.default_owner } : {}),
  });
  if (!config.vault.default_owner) {
    log.warn("[vault] default_owner is unset - vault rows with no owner are visible only to wildcard credentials");
  }
  const vault = createVaultRecall({
    repo: vaultRepo,
    documentEmbeddings: embeddings.documents,
    ...(config.vault.dir ? { vaultDir: config.vault.dir } : {}),
  });

  const mesh = buildMesh(config, log);

  return {
    serverDeps: { thoughts, kv, vault, search, log, mesh },
    mesh,
    close: async () => {
      // First: the entrypoints exit right after close() resolves, and a bye
      // that has not left the process by then is lost. farewell() waits for
      // it, bounded, and never rejects.
      await mesh.farewell();
      await db.close();
    },
  };
}
