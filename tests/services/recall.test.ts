/**
 * The namespace must reach the vault leg. Before 0003, runMergedRecall passed
 * `agents` to the thoughts leg and nothing to searchDocuments, so every
 * credential read every document. The first describe is the test that fails
 * on that code; the second pins that createVaultRecall forwards the namespace
 * to every repository read.
 */

import { describe, expect, it } from "vitest";
import { createVaultRecall, runMergedRecall } from "../../src/services/recall.js";
import type { VaultReadRepository } from "../../src/repositories/vault.js";

describe("runMergedRecall namespace propagation", () => {
  const thoughts = { searchRanked: async () => [] };

  it("passes the caller's namespaces to the documents leg", async () => {
    const seen: (readonly string[])[] = [];
    const vault = {
      searchDocuments: async (_query: string, opts: { agents: readonly string[] }) => {
        seen.push(opts.agents);
        return [];
      },
    };
    await runMergedRecall({ thoughts, vault }, { query: "q", agents: ["alex"], limit: 5, corpus: "all" });
    expect(seen).toEqual([["alex"]]);
  });

  it("does so for the documents-only corpus too", async () => {
    const seen: (readonly string[])[] = [];
    const vault = {
      searchDocuments: async (_query: string, opts: { agents: readonly string[] }) => {
        seen.push(opts.agents);
        return [];
      },
    };
    await runMergedRecall({ thoughts, vault }, { query: "q", agents: ["jackie"], limit: 5, corpus: "documents" });
    expect(seen).toEqual([["jackie"]]);
  });
});

describe("createVaultRecall forwards the namespace to the repository", () => {
  function fakeRepo() {
    const seen: Record<string, readonly string[]> = {};
    const repo: VaultReadRepository = {
      searchChunks: async (_e, o) => {
        seen["searchChunks"] = o.agents;
        return [];
      },
      listChunksByDocument: async () => [],
      getDocument: async (_id, agents) => {
        seen["getDocument"] = agents;
        return undefined;
      },
      getNodeByPath: async (_p, agents) => {
        seen["getNodeByPath"] = agents;
        return undefined;
      },
      listNodesByDepth: async (_d, agents) => {
        seen["listNodesByDepth"] = agents;
        return [];
      },
      listChildrenOf: async (_p, agents) => {
        seen["listChildrenOf"] = agents;
        return [];
      },
      searchNodes: async (_e, o) => {
        seen["searchNodes"] = o.agents;
        return [];
      },
    };
    return { repo, seen };
  }
  const documentEmbeddings = { embed: async () => Array.from({ length: 1024 }, () => 0) };

  it("on every read path", async () => {
    const { repo, seen } = fakeRepo();
    const recall = createVaultRecall({ repo, documentEmbeddings });
    const agents = ["alex"];
    await recall.searchDocuments("q", { agents, limit: 5 });
    await recall.readDocument("doc-1", { agents });
    await recall.treeRead("mail/2026", { agents });
    await recall.treeList({ agents });
    await recall.treeList({ agents, path: "mail/2026" });
    await recall.treeSearch("q", { agents, limit: 5 });
    expect(seen).toEqual({
      searchChunks: ["alex"],
      getDocument: ["alex"],
      getNodeByPath: ["alex"],
      listNodesByDepth: ["alex"],
      listChildrenOf: ["alex"],
      searchNodes: ["alex"],
    });
  });
});
