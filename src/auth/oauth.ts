/**
 * OAuth 2.1 resource-server leg: verify a Keycloak-issued JWT (jose + cached
 * remote JWKS), assert issuer and audience, and map claims to an AgentIdentity.
 *
 * Audience validation is strict per the MCP authorization spec: a token not
 * issued for this resource is rejected outright. Both bare and trailing-slash
 * audience forms are accepted because the Claude connector canonicalises the
 * resource to 'https://host/'.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { z } from "zod";
import type { AppConfig, Scope } from "../config/index.js";
import { ScopeSchema } from "../config/index.js";
import type { AgentIdentity } from "./identity.js";

const DiscoverySchema = z.object({ jwks_uri: z.string().url() }).loose();

function scopeValues(payload: JWTPayload, claim: "scope" | "scp"): Scope[] {
  const value = payload[claim];
  const raw =
    typeof value === "string"
      ? value.split(/\s+/).filter(Boolean)
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
  return raw.filter((item): item is Scope => ScopeSchema.safeParse(item).success);
}

function agentValues(payload: JWTPayload, claim: string): string[] {
  const value = payload[claim];
  if (typeof value === "string") return value.split(/[\s,]+/).filter(Boolean);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

export class OAuthVerifier {
  private keyPromise: Promise<JWTVerifyGetKey> | null = null;

  constructor(
    private readonly config: AppConfig["auth"]["oauth"],
    key?: JWTVerifyGetKey,
  ) {
    if (key) this.keyPromise = Promise.resolve(key);
  }

  /** Verify a bearer JWT; null on any failure (the transport answers 401). */
  async verify(token: string): Promise<AgentIdentity | null> {
    if (!this.config.enabled) return null;
    const audience = this.config.audience.replace(/\/+$/, "");
    try {
      const { payload } = await jwtVerify(token, await this.getKey(), {
        issuer: this.config.issuer,
        audience: [audience, `${audience}/`],
      });
      const agents = agentValues(payload, this.config.agents_claim);
      if (agents.length === 0) return null; // a token with no namespace claim has no memory identity
      const subject = typeof payload.sub === "string" ? payload.sub : "unknown";
      const clientId = typeof payload.client_id === "string" ? payload.client_id : subject;
      return {
        name: `oauth:${clientId}`,
        agents,
        scopes: scopeValues(payload, this.config.scope_claim),
      };
    } catch {
      return null;
    }
  }

  private getKey(): Promise<JWTVerifyGetKey> {
    this.keyPromise ??= this.resolveKey();
    return this.keyPromise;
  }

  private async resolveKey(): Promise<JWTVerifyGetKey> {
    if (this.config.jwks_uri) {
      return createRemoteJWKSet(new URL(this.config.jwks_uri));
    }
    const issuer = this.config.issuer.replace(/\/+$/, "");
    const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`OIDC discovery returned HTTP ${response.status}`);
    }
    const discovery = DiscoverySchema.parse(await response.json());
    return createRemoteJWKSet(new URL(discovery.jwks_uri));
  }
}
