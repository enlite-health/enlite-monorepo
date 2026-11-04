import { AuthorizationOverlapsError, AuthorizationNotFoundError } from '../ContractedServiceAuthorization';

describe('ContractedServiceAuthorization', () => {
  it('erros de domínio carregam o code da API', () => {
    expect(new AuthorizationOverlapsError().code).toBe('AUTHORIZATION_OVERLAPS');
    expect(new AuthorizationNotFoundError().code).toBe('AUTHORIZATION_NOT_FOUND');
  });
});
