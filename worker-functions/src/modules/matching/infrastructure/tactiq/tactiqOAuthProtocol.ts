/**
 * Partes PURAS do OAuth do Tactiq (cliente público, PKCE S256, spec 049 F4) — separadas do `fetch` para serem
 * testadas sem tocar o Tactiq. Nada aqui devolve ou registra o corpo da resposta: só um desfecho fechado.
 */
import {
  TactiqInvalidGrantError,
  TactiqNotConfiguredError,
  TactiqTransientError,
  TactiqUnauthorizedError,
  type TactiqTokenSet,
} from '../../application/ports/TactiqPorts';

export const DEFAULT_TACTIQ_SCOPE = 'mcp:meetings:own mcp:meetings:details';

export interface TactiqOAuthConfig {
  mcpUrl: string;
  clientId: string;
  redirectUrl: string;
  scope: string;
}

export function readTactiqOAuthConfig(env: NodeJS.ProcessEnv): TactiqOAuthConfig {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new TactiqNotConfiguredError(k);
    return v;
  };
  return {
    mcpUrl: need('TACTIQ_MCP_URL'),
    clientId: need('TACTIQ_OAUTH_CLIENT_ID'),
    redirectUrl: need('TACTIQ_OAUTH_REDIRECT_URL'),
    scope: env.TACTIQ_OAUTH_SCOPE || DEFAULT_TACTIQ_SCOPE,
  };
}

export function buildAuthorizeUrl(
  authorizationEndpoint: string,
  cfg: TactiqOAuthConfig,
  input: { state: string; codeChallenge: string },
): string {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUrl);
  url.searchParams.set('scope', cfg.scope);
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', cfg.mcpUrl);
  return url.toString();
}

/** Cliente PÚBLICO: nenhum `client_secret` no corpo. */
export function codeExchangeBody(cfg: TactiqOAuthConfig, input: { code: string; codeVerifier: string }): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: cfg.redirectUrl,
    client_id: cfg.clientId,
    code_verifier: input.codeVerifier,
    resource: cfg.mcpUrl,
  });
}

export function refreshBody(cfg: TactiqOAuthConfig, refreshToken: string): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    resource: cfg.mcpUrl,
  });
}

/**
 * Resposta do endpoint de token → tokens, ou o erro de domínio certo. `invalid_grant` (400) = vínculo caído;
 * 401/403 = recusado; o resto (5xx, rede, corpo ilegível) = transitório. O corpo NUNCA vai para a mensagem.
 */
export function parseTokenResponse(status: number, body: unknown): TactiqTokenSet {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (status >= 200 && status < 300) {
    if (typeof b.access_token !== 'string' || !b.access_token) throw new TactiqTransientError('token_response_without_access_token');
    return {
      accessToken: b.access_token,
      ...(typeof b.refresh_token === 'string' && b.refresh_token ? { refreshToken: b.refresh_token } : {}),
    };
  }
  if (b.error === 'invalid_grant') throw new TactiqInvalidGrantError();
  if (status === 401 || status === 403) throw new TactiqUnauthorizedError();
  if (status === 400) throw new TactiqInvalidGrantError(); // invalid_request/invalid_client no refresh: o vínculo não se recupera sozinho
  throw new TactiqTransientError(`token_http_${status}`);
}
