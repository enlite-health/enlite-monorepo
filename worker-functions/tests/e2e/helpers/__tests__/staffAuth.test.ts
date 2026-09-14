/**
 * Unit do `staffAuth` — só o ramo MOCK (sem emulador de pé, que é o caso do CI
 * e desta máquina). `country` é OPCIONAL: sem ele, o claim tem que sair
 * IDÊNTICO ao objeto que o helper gerava antes desta mudança — é o teste que
 * MORRE se o default silenciosamente virar outro valor ou se o campo aparecer
 * mesmo sem ser pedido.
 */
import { staffAuth } from '../staffAuth';

function decodeMockClaim(authorizationHeader: string): Record<string, unknown> {
  const token = authorizationHeader.replace('Bearer mock_', '');
  return JSON.parse(Buffer.from(token, 'base64').toString());
}

describe('staffAuth — claim `country` opcional (D330-country-helper)', () => {
  it('sem country: claim idêntico ao comportamento anterior — só uid, email, role', async () => {
    const auth = await staffAuth('u-sem-country', 'admin');
    expect(decodeMockClaim(auth.headers.Authorization)).toEqual({
      uid: 'u-sem-country',
      email: 'u-sem-country@e2e.local',
      role: 'admin',
    });
    expect(auth.uid).toBe('u-sem-country');
  });

  it('com country: claim carrega o valor pedido', async () => {
    const auth = await staffAuth('u-com-country', 'recruiter', 'AR');
    expect(decodeMockClaim(auth.headers.Authorization)).toEqual({
      uid: 'u-com-country',
      email: 'u-com-country@e2e.local',
      role: 'recruiter',
      country: 'AR',
    });
  });
});
