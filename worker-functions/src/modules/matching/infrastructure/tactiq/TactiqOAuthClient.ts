import {
  TactiqRealClientInTestError,
  TactiqTransientError,
  type TactiqOAuthPort,
  type TactiqTokenSet,
} from '../../application/ports/TactiqPorts';
import {
  buildAuthorizeUrl,
  codeExchangeBody,
  parseTokenResponse,
  readTactiqOAuthConfig,
  refreshBody,
  type TactiqOAuthConfig,
} from './tactiqOAuthProtocol';

interface Endpoints {
  authorization: string;
  token: string;
}

const HTTP_TIMEOUT_MS = 15_000;

/**
 * Cliente REAL do OAuth do Tactiq (cliente público + PKCE S256; sem secret). Descobre os endpoints em
 * `/.well-known/oauth-authorization-server` e os guarda na instância. A configuração é lida na CHAMADA (env faltando
 * lança `TactiqNotConfiguredError` na hora de usar, não derruba o boot).
 *
 * ⚠️ Lança no construtor com NODE_ENV=test: teste nunca toca o Tactiq (a fábrica só o constrói no modo `real`).
 */
export class TactiqOAuthClient implements TactiqOAuthPort {
  private endpoints: Endpoints | null = null;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    if (this.env.NODE_ENV === 'test') throw new TactiqRealClientInTestError('new TactiqOAuthClient()');
  }

  async buildAuthorizeUrl(input: { state: string; codeChallenge: string }): Promise<string> {
    const cfg = readTactiqOAuthConfig(this.env);
    const ep = await this.discover(cfg);
    return buildAuthorizeUrl(ep.authorization, cfg, input);
  }

  async exchangeCode(input: { code: string; codeVerifier: string }): Promise<TactiqTokenSet & { refreshToken: string }> {
    const cfg = readTactiqOAuthConfig(this.env);
    const ep = await this.discover(cfg);
    const tokens = parseTokenResponse(...(await this.postForm(ep.token, codeExchangeBody(cfg, input))));
    if (!tokens.refreshToken) throw new TactiqTransientError('exchange_without_refresh_token');
    return { ...tokens, refreshToken: tokens.refreshToken };
  }

  async refresh(refreshToken: string): Promise<TactiqTokenSet> {
    const cfg = readTactiqOAuthConfig(this.env);
    const ep = await this.discover(cfg);
    return parseTokenResponse(...(await this.postForm(ep.token, refreshBody(cfg, refreshToken))));
  }

  private async discover(cfg: TactiqOAuthConfig): Promise<Endpoints> {
    if (this.endpoints) return this.endpoints;
    const url = new URL('/.well-known/oauth-authorization-server', cfg.mcpUrl).toString();
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    } catch {
      throw new TactiqTransientError('discovery_network');
    }
    if (!res.ok) throw new TactiqTransientError(`discovery_http_${res.status}`);
    const meta = (await res.json().catch(() => ({}))) as { authorization_endpoint?: unknown; token_endpoint?: unknown };
    if (typeof meta.authorization_endpoint !== 'string' || typeof meta.token_endpoint !== 'string') {
      throw new TactiqTransientError('discovery_malformed');
    }
    this.endpoints = { authorization: meta.authorization_endpoint, token: meta.token_endpoint };
    return this.endpoints;
  }

  private async postForm(url: string, body: URLSearchParams): Promise<[number, unknown]> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      throw new TactiqTransientError('token_network');
    }
    return [res.status, await res.json().catch(() => ({}))];
  }
}
