import type { Application } from 'express';
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { OAuthTokenService } from '../application/oauth/OAuthTokenService';
import { StatelessClientsStore } from '../application/oauth/StatelessClientsStore';
import { EnliteOAuthProvider } from '../application/oauth/EnliteOAuthProvider';
import { renderConsentPage } from '../interfaces/oauth/consentPage';
import { createConsentRoutes, type StaffLookup } from '../interfaces/oauth/consentRoutes';
import type { OAuthAccessTokenVerifier } from '../interfaces/middleware/requireServicePrincipal';
import type { McpAuditEvent } from '../domain/McpAuditEvent';
import { MCP_OAUTH_SCOPE } from '../domain/OAuthScopes';

interface AuditEmitter {
  emit(event: McpAuditEvent): void;
}

export interface OAuthConfig {
  issuerUrl: string; // URL pública do service MCP (ex: https://worker-functions-mcp-xxx.run.app)
  signingKey: string;
  firebaseApiKey: string;
  firebaseAuthDomain: string;
}

export interface OAuthMountResult {
  verifier: OAuthAccessTokenVerifier;
  resourceMetadataUrl: string;
}

/**
 * Monta o authorization server OAuth 2.1 na raiz do app (conector claude.ai):
 * /.well-known/oauth-authorization-server + /.well-known/oauth-protected-resource
 * (RFC 8414/9728), /authorize, /token, /register (DCR) — tudo via mcpAuthRouter
 * do SDK — e o POST /oauth/consent (identidade Firebase, staff only).
 */
export function mountOAuthRoutes(
  app: Application,
  config: OAuthConfig,
  deps: {
    staffLookup: StaffLookup;
    auditor: AuditEmitter;
    /** Injetável em teste; default: admin.auth().verifyIdToken (ver consentRoutes) */
    verifyIdToken?: Parameters<typeof createConsentRoutes>[0]['verifyIdToken'];
  },
): OAuthMountResult {
  const issuerUrl = new URL(config.issuerUrl);
  const resourceServerUrl = new URL('/mcp/v1', issuerUrl);

  // Cloud Run fica atrás do Google Frontend: sem trust proxy, o express-rate-limit
  // do mcpAuthRouter agruparia todos os users no IP do LB (429 compartilhado).
  app.set('trust proxy', 1);

  const tokens = new OAuthTokenService(config.signingKey, issuerUrl.origin);
  const clientsStore = new StatelessClientsStore(tokens);
  const provider = new EnliteOAuthProvider({
    tokens,
    clientsStore,
    renderConsentPage: (params) =>
      renderConsentPage(
        { firebaseApiKey: config.firebaseApiKey, firebaseAuthDomain: config.firebaseAuthDomain },
        params,
      ),
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      resourceServerUrl,
      resourceName: 'Enlite Worker MCP',
      scopesSupported: [MCP_OAUTH_SCOPE],
      // client_id é gerado pelo StatelessClientsStore (JWT com os redirect_uris)
      clientRegistrationOptions: { clientIdGeneration: false },
    }),
  );

  app.use(
    '/oauth',
    createConsentRoutes({
      tokens,
      staffLookup: deps.staffLookup,
      auditor: deps.auditor,
      ...(deps.verifyIdToken !== undefined ? { verifyIdToken: deps.verifyIdToken } : {}),
    }),
  );

  return {
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  };
}
