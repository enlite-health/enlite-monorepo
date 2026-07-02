import { OAuthTokenService } from '../OAuthTokenService';
import { StatelessClientsStore } from '../StatelessClientsStore';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

function makeStore() {
  const tokens = new OAuthTokenService('a'.repeat(64), 'https://mcp.example.com');
  return { store: new StatelessClientsStore(tokens), tokens };
}

describe('StatelessClientsStore', () => {
  it('registerClient → getClient roundtrip (client público, PKCE, sem secret)', () => {
    const { store } = makeStore();
    const registered = store.registerClient({
      redirect_uris: [CLAUDE_CALLBACK],
      client_name: 'Claude',
      token_endpoint_auth_method: 'client_secret_post', // forçado pra 'none'
    });

    expect(registered.client_id).toBeTruthy();
    expect(registered.client_secret).toBeUndefined();
    expect(registered.token_endpoint_auth_method).toBe('none');
    expect(registered.grant_types).toEqual(['authorization_code', 'refresh_token']);

    const fetched = store.getClient(registered.client_id);
    expect(fetched).toBeDefined();
    expect(fetched?.redirect_uris).toEqual([CLAUDE_CALLBACK]);
    expect(fetched?.client_name).toBe('Claude');
    expect(fetched?.token_endpoint_auth_method).toBe('none');
  });

  it('rejeita registro sem redirect_uris', () => {
    const { store } = makeStore();
    expect(() => store.registerClient({ redirect_uris: [] })).toThrow(InvalidClientMetadataError);
  });

  it('rejeita redirect_uri http não-loopback', () => {
    const { store } = makeStore();
    expect(() =>
      store.registerClient({ redirect_uris: ['http://evil.example.com/cb'] }),
    ).toThrow(InvalidClientMetadataError);
  });

  it('aceita http loopback (RFC 8252 — MCP Inspector/CLIs locais)', () => {
    const { store } = makeStore();
    const registered = store.registerClient({
      redirect_uris: ['http://localhost:6274/oauth/callback'],
    });
    expect(store.getClient(registered.client_id)?.redirect_uris).toEqual([
      'http://localhost:6274/oauth/callback',
    ]);
  });

  it('client_id forjado/aleatório → undefined', () => {
    const { store } = makeStore();
    expect(store.getClient('random-client-id')).toBeUndefined();
    expect(store.getClient('eyJhbGciOiJIUzI1NiJ9.eyJ4IjoxfQ.forged')).toBeUndefined();
  });
});
