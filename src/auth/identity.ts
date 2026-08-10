/**
 * AgentIdentity - what every authentication path resolves to, and the only
 * thing tools ever see. The credential carries the namespace: no tool takes an
 * agent_id parameter.
 */

import type { Scope } from "../config/index.js";

export interface AgentIdentity {
  /** Stable label for logs ('claude-code', 'oauth:sub', 'stdio'). */
  name: string;
  /** Namespaces this caller may touch. ['*'] means all namespaces. */
  agents: string[];
  scopes: Scope[];
}

/** The namespace a capture/kv write lands in: the first concrete agent. A
 *  wildcard-only identity has no write namespace and writes are refused. */
export function primaryAgent(identity: AgentIdentity): string | null {
  return identity.agents.find((agent) => agent !== "*") ?? null;
}

export function hasScope(identity: AgentIdentity, scope: Scope): boolean {
  return identity.scopes.includes(scope);
}
