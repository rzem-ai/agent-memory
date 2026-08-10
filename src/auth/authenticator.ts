/**
 * The authentication façade: one entry point the HTTP transport calls per
 * request, resolving to an AgentIdentity (or null -> 401 challenge).
 *
 * Order: static bearer table first (constant-time, no network), then OAuth JWT
 * verification. auth.enabled=false short-circuits to a full-scope development
 * identity - never ship that.
 */

import type { AppConfig, Scope } from "../config/index.js";
import { SCOPES } from "./scopes.js";
import { BearerTable } from "./bearer.js";
import { OAuthVerifier } from "./oauth.js";
import type { AgentIdentity } from "./identity.js";

export class Authenticator {
  private readonly bearer: BearerTable;
  private readonly oauth: OAuthVerifier;

  constructor(
    private readonly config: AppConfig["auth"],
    environment: NodeJS.ProcessEnv = process.env,
    oauthVerifier?: OAuthVerifier,
  ) {
    this.bearer = new BearerTable(config.tokens, environment);
    this.oauth = oauthVerifier ?? new OAuthVerifier(config.oauth);
  }

  async authenticate(authorizationHeader: string | undefined): Promise<AgentIdentity | null> {
    if (!this.config.enabled) {
      return { name: "development", agents: ["*"], scopes: [...SCOPES] as Scope[] };
    }
    if (!authorizationHeader?.startsWith("Bearer ")) return null;
    const token = authorizationHeader.slice("Bearer ".length).trim();
    if (!token) return null;

    const fromTable = this.bearer.match(token);
    if (fromTable) return fromTable;

    return this.oauth.verify(token);
  }

  /** The RFC 9728 protected-resource metadata document. */
  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.config.oauth.audience,
      authorization_servers: [this.config.oauth.issuer],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
    };
  }

  /** The metadata URL advertised in the 401 challenge. */
  resourceMetadataUrl(): string {
    return (
      this.config.oauth.resource_metadata_url ??
      `${this.config.oauth.audience.replace(/\/+$/, "")}/.well-known/oauth-protected-resource`
    );
  }
}
