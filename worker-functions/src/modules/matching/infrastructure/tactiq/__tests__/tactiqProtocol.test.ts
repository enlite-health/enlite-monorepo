/**
 * Partes puras do OAuth/MCP do Tactiq (spec 049 F4): PKCE, URL de autorização, corpos sem secret, mapa de erro.
 * Nada aqui toca a rede nem instancia o cliente real.
 */
import {
  TactiqInvalidGrantError,
  TactiqNotConfiguredError,
  TactiqTransientError,
  TactiqUnauthorizedError,
} from '../../../application/ports/TactiqPorts';
import { hashState, newOAuthState, newPkcePair, pkceChallenge } from '../pkce';
import {
  buildAuthorizeUrl,
  codeExchangeBody,
  DEFAULT_TACTIQ_SCOPE,
  parseTokenResponse,
  readTactiqOAuthConfig,
  refreshBody,
} from '../tactiqOAuthProtocol';
import { classifyMcpFailure, parseMcpJson, pingVerdict } from '../tactiqMcpProtocol';

const cfg = {
  mcpUrl: 'https://mcp.tactiq.example/mcp',
  clientId: 'mcp-cliente-publico',
  redirectUrl: 'https://api.example.test/api/admin/me/tactiq-link/callback',
  scope: DEFAULT_TACTIQ_SCOPE,
};

describe('PKCE (RFC 7636)', () => {
  it('o vetor de teste do apêndice B da RFC', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('o par gerado: verifier de 43 caracteres base64url e desafio S256 coerente; dois pares nunca repetem', () => {
    const a = newPkcePair();
    const b = newPkcePair();
    expect(a.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.codeChallenge).toBe(pkceChallenge(a.codeVerifier));
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });

  it('state: 256 bits opacos, e o banco guarda só o hash (sha256 hex de 64 caracteres, que não contém o state)', () => {
    const state = newOAuthState();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const h = hashState(state);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(state);
    expect(hashState(state)).toBe(h);
  });
});

describe('URL de autorização e corpos do token — cliente PÚBLICO (sem client_secret)', () => {
  it('a URL leva S256, client_id, redirect, state, scope e o resource do MCP — e nenhum secret', () => {
    const url = new URL(buildAuthorizeUrl('https://mcp.tactiq.example/oauth/authorize', cfg, { state: 'st', codeChallenge: 'ch' }));
    expect(url.origin + url.pathname).toBe('https://mcp.tactiq.example/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUrl,
      scope: DEFAULT_TACTIQ_SCOPE,
      state: 'st',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      resource: cfg.mcpUrl,
    });
  });

  it('troca de código: grant, verifier e client_id — sem client_secret; refresh: sem verifier e sem secret', () => {
    const ex = codeExchangeBody(cfg, { code: 'c1', codeVerifier: 'v1' });
    expect(Object.fromEntries(ex)).toMatchObject({ grant_type: 'authorization_code', code: 'c1', code_verifier: 'v1', client_id: cfg.clientId, redirect_uri: cfg.redirectUrl });
    expect(ex.has('client_secret')).toBe(false);
    const rf = refreshBody(cfg, 'rt-1');
    expect(Object.fromEntries(rf)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: cfg.clientId });
    expect(rf.has('client_secret')).toBe(false);
    expect(rf.has('code_verifier')).toBe(false);
  });

  it('env faltando lança TactiqNotConfiguredError nomeando a variável (na chamada, não no boot)', () => {
    expect(() => readTactiqOAuthConfig({ TACTIQ_MCP_URL: 'https://x' })).toThrow(TactiqNotConfiguredError);
    expect(() => readTactiqOAuthConfig({ TACTIQ_MCP_URL: 'https://x', TACTIQ_OAUTH_CLIENT_ID: 'c' })).toThrow(/TACTIQ_OAUTH_REDIRECT_URL/);
    expect(readTactiqOAuthConfig({ TACTIQ_MCP_URL: 'https://x', TACTIQ_OAUTH_CLIENT_ID: 'c', TACTIQ_OAUTH_REDIRECT_URL: 'https://r' }).scope).toBe(DEFAULT_TACTIQ_SCOPE);
  });
});

describe('parseTokenResponse — desfecho fechado, o corpo nunca vai para o erro', () => {
  it('200 com refresh → par; 200 sem refresh → só o access (o chamador decide)', () => {
    expect(parseTokenResponse(200, { access_token: 'at', refresh_token: 'rt' })).toEqual({ accessToken: 'at', refreshToken: 'rt' });
    expect(parseTokenResponse(200, { access_token: 'at' })).toEqual({ accessToken: 'at' });
  });

  it('200 sem access_token → transitório', () => {
    expect(() => parseTokenResponse(200, {})).toThrow(TactiqTransientError);
  });

  it('invalid_grant (400) e 400 genérico → TactiqInvalidGrantError', () => {
    expect(() => parseTokenResponse(400, { error: 'invalid_grant' })).toThrow(TactiqInvalidGrantError);
    expect(() => parseTokenResponse(400, { error: 'invalid_request' })).toThrow(TactiqInvalidGrantError);
  });

  it('401/403 → TactiqUnauthorizedError; 5xx → transitório', () => {
    expect(() => parseTokenResponse(401, {})).toThrow(TactiqUnauthorizedError);
    expect(() => parseTokenResponse(403, {})).toThrow(TactiqUnauthorizedError);
    expect(() => parseTokenResponse(503, { error_description: 'rt-segredo' })).toThrow(TactiqTransientError);
    try { parseTokenResponse(500, { access_token: 'at-segredo', refresh_token: 'rt-segredo' }); } catch (e) {
      expect((e as Error).message).not.toContain('segredo');
    }
  });
});

describe('MCP — leitura do resultado e classificação de falha', () => {
  const toolResult = (obj: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

  it('parseMcpJson lê o 1º bloco de texto; sem bloco / JSON ruim → null', () => {
    expect(parseMcpJson(toolResult({ a: 1 }))).toEqual({ a: 1 });
    expect(parseMcpJson({ content: [] })).toBeNull();
    expect(parseMcpJson({ content: [{ type: 'text', text: 'não é json' }] })).toBeNull();
    expect(parseMcpJson(null)).toBeNull();
  });

  it('ping: action=ready (F0.4) → ok; outra action → denied; formato desconhecido → ok (a 401 já seria erro de transporte)', () => {
    expect(pingVerdict(toolResult({ access: { action: 'ready', title: 'x' } }))).toBe('ok');
    expect(pingVerdict(toolResult({ access: { action: 'upgrade_required' } }))).toBe('denied');
    expect(pingVerdict(toolResult({ qualquer: 'coisa' }))).toBe('ok');
  });

  it('401/403 e UnauthorizedError do SDK → vínculo caído; o resto → transitório; erros de domínio passam intactos', () => {
    expect(classifyMcpFailure({ code: 401 })).toBeInstanceOf(TactiqUnauthorizedError);
    expect(classifyMcpFailure({ code: 403 })).toBeInstanceOf(TactiqUnauthorizedError);
    expect(classifyMcpFailure({ name: 'UnauthorizedError' })).toBeInstanceOf(TactiqUnauthorizedError);
    expect(classifyMcpFailure({ code: 502 })).toBeInstanceOf(TactiqTransientError);
    expect(classifyMcpFailure(new Error('ECONNRESET rt-segredo'))).toBeInstanceOf(TactiqTransientError);
    expect(classifyMcpFailure(new Error('ECONNRESET rt-segredo')).message).not.toContain('segredo');
    const u = new TactiqUnauthorizedError();
    expect(classifyMcpFailure(u)).toBe(u);
  });
});
