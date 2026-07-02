import type { Response } from 'express';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { OAUTH_TOKEN_TTL_SECONDS, OAuthTokenService } from './OAuthTokenService';
import { MCP_OAUTH_SCOPE } from '../../domain/OAuthScopes';

export interface ConsentPageParams {
  requestContext: string;
  clientName?: string;
  scope: string;
}

interface Deps {
  tokens: OAuthTokenService;
  clientsStore: OAuthRegisteredClientsStore;
  renderConsentPage: (params: ConsentPageParams) => string;
}

/**
 * Authorization server stateless do MCP. O SDK (mcpAuthRouter) valida PKCE
 * S256 sozinho via challengeForAuthorizationCode; aqui só guardamos o
 * challenge dentro do próprio code (JWT) e emitimos access/refresh tokens.
 * A identidade entra pela página de consent (Firebase Google, staff only) —
 * ver interfaces/oauth/consentRoutes.ts.
 */
export class EnliteOAuthProvider implements OAuthServerProvider {
  /** Anti-replay best-effort do authorization code (por instância). */
  private readonly usedCodeJtis = new Map<string, number>();

  constructor(private readonly deps: Deps) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.deps.clientsStore;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const scope = MCP_OAUTH_SCOPE; // v1: escopo fixo read-only, ignora scopes pedidos
    const requestContext = this.deps.tokens.signConsentRequest({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scope,
      ...(params.state !== undefined ? { state: params.state } : {}),
    });

    res
      .status(200)
      .type('html')
      .send(
        this.deps.renderConsentPage({
          requestContext,
          scope,
          ...(client.client_name !== undefined ? { clientName: client.client_name } : {}),
        }),
      );
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const payload = this.deps.tokens.verifyCode(authorizationCode);
    if (!payload || payload.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return payload.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const payload = this.deps.tokens.verifyCode(authorizationCode);
    if (!payload || payload.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (redirectUri !== undefined && redirectUri !== payload.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match authorization request');
    }
    if (this.isCodeUsed(payload.jti)) {
      throw new InvalidGrantError('Authorization code already used');
    }
    this.markCodeUsed(payload.jti);

    return this.issueTokens(client.client_id, payload.email, payload.role, payload.scope);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const payload = this.deps.tokens.verifyRefresh(refreshToken);
    if (!payload || payload.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    return this.issueTokens(client.client_id, payload.email, payload.role, payload.scope);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const payload = this.deps.tokens.verifyAccess(token);
    if (!payload) {
      throw new InvalidTokenError('Invalid or expired access token');
    }
    return {
      token,
      clientId: payload.clientId,
      scopes: payload.scope.split(' '),
      expiresAt: payload.exp,
      extra: { email: payload.email, role: payload.role },
    };
  }

  // ── internos ───────────────────────────────────────────────────────────────

  private issueTokens(clientId: string, email: string, role: string, scope: string): OAuthTokens {
    return {
      access_token: this.deps.tokens.signAccess({ clientId, email, role, scope }),
      token_type: 'bearer',
      expires_in: OAUTH_TOKEN_TTL_SECONDS.access,
      scope,
      refresh_token: this.deps.tokens.signRefresh({ clientId, email, role, scope }),
    };
  }

  private isCodeUsed(jti: string): boolean {
    this.pruneUsedCodes();
    return this.usedCodeJtis.has(jti);
  }

  private markCodeUsed(jti: string): void {
    this.usedCodeJtis.set(jti, Date.now() + OAUTH_TOKEN_TTL_SECONDS.code * 2 * 1000);
  }

  private pruneUsedCodes(): void {
    const now = Date.now();
    for (const [jti, expiresAt] of this.usedCodeJtis) {
      if (expiresAt <= now) this.usedCodeJtis.delete(jti);
    }
  }
}
