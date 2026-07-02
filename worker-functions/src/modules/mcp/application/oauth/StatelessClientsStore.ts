import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthTokenService } from './OAuthTokenService';
import { MCP_OAUTH_SCOPE } from '../../domain/OAuthScopes';

/**
 * Clients store sem storage: o próprio client_id é um JWT assinado contendo
 * os redirect_uris registrados. DCR aberto (claude.ai registra sozinho ao
 * colar a URL) — o risco é neutralizado porque o consent exige login de staff
 * Enlite e todo client é público (PKCE obrigatório, sem client_secret).
 */
export class StatelessClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly tokens: OAuthTokenService) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const payload = this.tokens.verifyClient(clientId);
    if (!payload) return undefined;
    return {
      client_id: clientId,
      redirect_uris: payload.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: MCP_OAUTH_SCOPE,
      ...(payload.clientName !== undefined ? { client_name: payload.clientName } : {}),
    };
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): OAuthClientInformationFull {
    const redirectUris = client.redirect_uris ?? [];
    if (redirectUris.length === 0) {
      throw new InvalidClientMetadataError('redirect_uris is required');
    }
    for (const uri of redirectUris) {
      if (!isAllowedRedirectUri(uri)) {
        throw new InvalidClientMetadataError(
          `redirect_uri must be https (or http loopback for dev tools): ${uri}`,
        );
      }
    }

    const clientId = this.tokens.signClient({
      redirectUris,
      ...(client.client_name !== undefined ? { clientName: client.client_name } : {}),
    });

    return {
      ...client,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      // Client público: PKCE obrigatório no /token, nunca emitimos secret.
      token_endpoint_auth_method: 'none',
      client_secret: undefined,
      client_secret_expires_at: undefined,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: MCP_OAUTH_SCOPE,
    };
  }
}

function isAllowedRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === 'https:') return true;
    // RFC 8252 §7.3 — loopback http é permitido (MCP Inspector, CLIs locais)
    return (
      parsed.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}
