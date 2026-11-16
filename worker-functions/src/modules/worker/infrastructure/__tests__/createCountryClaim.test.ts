import { createCountryClaim } from '../createCountryClaim';
import { FirebaseCountryClaim } from '../FirebaseCountryClaim';
import { InMemoryCountryClaim } from '../InMemoryCountryClaim';

describe('createCountryClaim — fiação do port por USE_MOCK_AUTH (PR #875)', () => {
  it('USE_MOCK_AUTH=true: fake em memória, sem Firebase', () => {
    expect(createCountryClaim({ USE_MOCK_AUTH: 'true' })).toBeInstanceOf(InMemoryCountryClaim);
  });

  it.each([{}, { USE_MOCK_AUTH: 'false' }, { USE_MOCK_AUTH: '' }, { USE_MOCK_AUTH: 'TRUE' }])(
    'sem mock-auth (%j): adapter do Identity Platform',
    (env) => {
      expect(createCountryClaim(env as NodeJS.ProcessEnv)).toBeInstanceOf(FirebaseCountryClaim);
    },
  );

  it('o fake registra a escrita e nunca troca um claim já posto', async () => {
    const fake = new InMemoryCountryClaim();
    expect(await fake.ensureCountry('u1', 'BR')).toBe('provisioned');
    expect(await fake.ensureCountry('u1', 'AR')).toBe('already_set');
    expect(fake.claims.get('u1')).toBe('BR');
  });
});
