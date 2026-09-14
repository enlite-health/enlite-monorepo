/**
 * Unit do `tokenMock` (permissionFamilyHarness) — `country` é OPCIONAL: sem
 * ele, o claim tem que sair IDÊNTICO ao objeto que o helper gerava antes
 * desta mudança. Os outros 30+ chamadores só passam `(uid)` ou `(uid, role)`
 * — é esse caminho que não pode mudar.
 */
import { tokenMock } from '../permissionFamilyHarness';

function decodeMockClaim(authorizationHeader: string): Record<string, unknown> {
  const token = authorizationHeader.replace('Bearer mock_', '');
  return JSON.parse(Buffer.from(token, 'base64').toString());
}

describe('tokenMock — claim `country` opcional (D330-country-helper)', () => {
  it('sem argumentos além do uid: claim idêntico ao comportamento anterior (role default admin)', () => {
    expect(decodeMockClaim(tokenMock('u1'))).toEqual({
      uid: 'u1',
      email: 'u1@e2e.local',
      role: 'admin',
    });
  });

  it('com role explícita e sem country: claim idêntico ao comportamento anterior', () => {
    expect(decodeMockClaim(tokenMock('u2', 'recruiter'))).toEqual({
      uid: 'u2',
      email: 'u2@e2e.local',
      role: 'recruiter',
    });
  });

  it('com country: claim carrega o valor pedido', () => {
    expect(decodeMockClaim(tokenMock('u3', 'recruiter', 'BR'))).toEqual({
      uid: 'u3',
      email: 'u3@e2e.local',
      role: 'recruiter',
      country: 'BR',
    });
  });
});
