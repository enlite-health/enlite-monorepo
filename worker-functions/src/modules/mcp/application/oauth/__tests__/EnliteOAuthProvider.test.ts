import httpMocks from 'node-mocks-http';
import type { Response } from 'express';
import { OAuthTokenService } from '../OAuthTokenService';
import { StatelessClientsStore } from '../StatelessClientsStore';
import { EnliteOAuthProvider } from '../EnliteOAuthProvider';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

function setup() {
  const tokens = new OAuthTokenService('a'.repeat(64), 'https://mcp.example.com');
  const clientsStore = new StatelessClientsStore(tokens);
  const renderConsentPage = jest.fn().mockReturnValue('<html>consent</html>');
  const provider = new EnliteOAuthProvider({ tokens, clientsStore, renderConsentPage });
  const client = clientsStore.registerClient({
    redirect_uris: [CALLBACK],
    client_name: 'Claude',
  }) as OAuthClientInformationFull;
  return { tokens, provider, client, renderConsentPage, clientsStore };
}

function mintCode(
  tokens: OAuthTokenService,
  client: OAuthClientInformationFull,
  overrides: Partial<Parameters<OAuthTokenService['signCode']>[0]> = {},
): string {
  return tokens.signCode({
    clientId: client.client_id,
    redirectUri: CALLBACK,
    codeChallenge: 'challenge-abc',
    scope: 'worker:read',
    email: 'ana@enlite.health',
    role: 'recruiter',
    ...overrides,
  });
}

describe('EnliteOAuthProvider', () => {
  it('authorize renderiza a consent page com request context assinado', async () => {
    const { provider, client, renderConsentPage, tokens } = setup();
    const res = httpMocks.createResponse();

    await provider.authorize(
      client,
      { codeChallenge: 'challenge-abc', redirectUri: CALLBACK, state: 'st' },
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(200);
    expect(res._getData()).toBe('<html>consent</html>');
    const params = renderConsentPage.mock.calls[0][0] as { requestContext: string };
    const ctx = tokens.verifyConsentRequest(params.requestContext);
    expect(ctx).toMatchObject({
      clientId: client.client_id,
      redirectUri: CALLBACK,
      codeChallenge: 'challenge-abc',
      state: 'st',
      scope: 'worker:read',
    });
  });

  it('challengeForAuthorizationCode devolve o challenge guardado no code (PKCE do SDK)', async () => {
    const { provider, client, tokens } = setup();
    const code = mintCode(tokens, client);
    await expect(provider.challengeForAuthorizationCode(client, code)).resolves.toBe(
      'challenge-abc',
    );
  });

  it('exchangeAuthorizationCode: happy path emite access+refresh com identidade do staff', async () => {
    const { provider, client, tokens } = setup();
    const code = mintCode(tokens, client);

    const result = await provider.exchangeAuthorizationCode(client, code, undefined, CALLBACK);

    expect(result.token_type).toBe('bearer');
    expect(result.scope).toBe('worker:read');
    const access = tokens.verifyAccess(result.access_token);
    expect(access).toMatchObject({ email: 'ana@enlite.health', role: 'recruiter' });
    expect(tokens.verifyRefresh(result.refresh_token as string)).toMatchObject({
      email: 'ana@enlite.health',
    });
  });

  it('code de outro client → InvalidGrantError', async () => {
    const { provider, tokens, clientsStore } = setup();
    const otherClient = clientsStore.registerClient({
      redirect_uris: [CALLBACK],
      client_name: 'Other',
    }) as OAuthClientInformationFull;
    const code = mintCode(tokens, otherClient);
    const victim = clientsStore.registerClient({
      redirect_uris: [CALLBACK],
      client_name: 'Victim',
    }) as OAuthClientInformationFull;

    await expect(provider.exchangeAuthorizationCode(victim, code)).rejects.toThrow(
      InvalidGrantError,
    );
  });

  it('redirect_uri divergente → InvalidGrantError', async () => {
    const { provider, client, tokens } = setup();
    const code = mintCode(tokens, client);
    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, 'https://evil.example.com/cb'),
    ).rejects.toThrow(InvalidGrantError);
  });

  it('replay do mesmo code → InvalidGrantError na segunda troca', async () => {
    const { provider, client, tokens } = setup();
    const code = mintCode(tokens, client);
    await provider.exchangeAuthorizationCode(client, code, undefined, CALLBACK);
    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, CALLBACK),
    ).rejects.toThrow(/already used/);
  });

  it('exchangeRefreshToken: rotaciona e mantém identidade', async () => {
    const { provider, client, tokens } = setup();
    const refresh = tokens.signRefresh({
      clientId: client.client_id,
      scope: 'worker:read',
      email: 'ana@enlite.health',
      role: 'admin',
    });

    const result = await provider.exchangeRefreshToken(client, refresh);
    expect(tokens.verifyAccess(result.access_token)).toMatchObject({ role: 'admin' });
    expect(result.refresh_token).toBeTruthy();
  });

  it('refresh de outro client → InvalidGrantError', async () => {
    const { provider, client, tokens } = setup();
    const refresh = tokens.signRefresh({
      clientId: 'other-client',
      scope: 'worker:read',
      email: 'a@enlite.health',
      role: 'admin',
    });
    await expect(provider.exchangeRefreshToken(client, refresh)).rejects.toThrow(
      InvalidGrantError,
    );
  });

  it('verifyAccessToken: válido → AuthInfo com email/role; inválido → InvalidTokenError', async () => {
    const { provider, client, tokens } = setup();
    const access = tokens.signAccess({
      clientId: client.client_id,
      scope: 'worker:read',
      email: 'ana@enlite.health',
      role: 'recruiter',
    });

    const info = await provider.verifyAccessToken(access);
    expect(info.clientId).toBe(client.client_id);
    expect(info.scopes).toEqual(['worker:read']);
    expect(info.extra).toMatchObject({ email: 'ana@enlite.health', role: 'recruiter' });

    await expect(provider.verifyAccessToken('garbage')).rejects.toThrow(InvalidTokenError);
  });
});
