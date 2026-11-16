import type { ICountryClaimPort } from '../ports/ICountryClaimPort';
import { FirebaseCountryClaim } from './FirebaseCountryClaim';
import { InMemoryCountryClaim } from './InMemoryCountryClaim';

/**
 * Fiação do port do claim `country`: o fake em memória só conta com `USE_MOCK_AUTH=true` (a mesma chave do e2e, como
 * em `createServiceIdentityVerifier`); em qualquer outro ambiente o único adapter é o do Identity Platform.
 */
export function createCountryClaim(env: NodeJS.ProcessEnv = process.env): ICountryClaimPort {
  return env.USE_MOCK_AUTH === 'true' ? new InMemoryCountryClaim() : new FirebaseCountryClaim();
}
