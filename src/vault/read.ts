/**
 * Read-only vault file access - the subset of the upstream ingestion code
 * that readDocument needs: resolve a stored
 * vault path safely under the vault root, read the Markdown, strip the YAML
 * frontmatter block, return the body. The full frontmatter row rebuild is a
 * write-side concern and is not ported.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export class VaultDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultDocumentError";
  }
}

/**
 * Resolve `vaultPath` against the vault root and assert the result stays inside
 * it. Defence in depth: a stored path with `..` or an absolute component is
 * refused rather than escaping the vault. Pure (no IO).
 */
export function resolveUnderVault(vaultDir: string, vaultPath: string): string {
  const root = path.resolve(vaultDir);
  const absPath = path.resolve(root, vaultPath);
  const rel = path.relative(root, absPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new VaultDocumentError(`resolved path escapes the vault: ${vaultPath}`);
  }
  return absPath;
}

// The leading frontmatter block: `---`, the YAML, a closing `---` on its own line.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

/** Strip the frontmatter block and the single blank line the writer places
 *  after it. Throws when the block is missing (the caller falls back to chunks). */
export function bodyFromVaultMarkdown(markdown: string): string {
  const match = FRONTMATTER_RE.exec(markdown);
  if (!match) {
    throw new VaultDocumentError("missing YAML frontmatter block");
  }
  return markdown.slice(match[0].length).replace(/^\r?\n/, "");
}

/** Read a vault document's body by its stored vault path. */
export async function readVaultBody(vaultDir: string, vaultPath: string): Promise<string> {
  const absPath = resolveUnderVault(vaultDir, vaultPath);
  const raw = await readFile(absPath, "utf8");
  return bodyFromVaultMarkdown(raw);
}
