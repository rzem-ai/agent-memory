/**
 * Static bearer tokens: the configured token table, secrets resolved once at
 * startup (a missing secret fails boot, not the first request), compared in
 * constant time per request.
 */

import { timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config/index.js";
import { resolveSecret } from "../config/index.js";
import type { AgentIdentity } from "./identity.js";

interface ResolvedToken {
  identity: AgentIdentity;
  secret: string;
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class BearerTable {
  private readonly tokens: ResolvedToken[];

  constructor(config: AppConfig["auth"]["tokens"], environment: NodeJS.ProcessEnv = process.env) {
    this.tokens = config.map((token) => {
      const secret = resolveSecret(token.secret, environment);
      if (!secret) {
        throw new Error(`Static token '${token.name}' resolved to an empty secret`);
      }
      return {
        secret,
        identity: { name: token.name, agents: [...token.agents], scopes: [...token.scopes] },
      };
    });
  }

  /** Match a presented bearer value against the table. Every entry is compared
   *  (no early exit on mismatch beyond the length gate inside timingSafeEqual). */
  match(presented: string): AgentIdentity | null {
    let matched: AgentIdentity | null = null;
    for (const token of this.tokens) {
      if (constantTimeEqual(presented, token.secret)) {
        matched ??= token.identity;
      }
    }
    return matched;
  }
}
