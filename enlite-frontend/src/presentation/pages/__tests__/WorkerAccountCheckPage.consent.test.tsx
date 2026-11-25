import { describe, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { claimServiceMock, expectConsentRequiredAndSent } from './claimConsent.helpers';

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'es' } }) }));
vi.mock('@presentation/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'uid-1', email: 'g@x.com', name: 'G', roles: [] }, logout: vi.fn() }),
}));
vi.mock('@presentation/hooks/useWorkerApi', () => ({ useWorkerApi: () => ({ initWorker: vi.fn() }) }));
vi.mock('@infrastructure/http/AuthClaimApiService', () => claimServiceMock());
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({ FirebaseAuthService: class {} }));

import { WorkerAccountCheckPage } from '../WorkerAccountCheckPage';
import { handOffInitOutcome, clearInitOutcome } from '@presentation/utils/workerInitOutcome';

describe('WorkerAccountCheckPage (1º login com Google) — aceite no claim', () => {
  beforeEach(() => { vi.clearAllMocks(); clearInitOutcome(); });

  it('o código só confirma com a caixa do aceite marcada, e o confirm leva lgpdOptIn: true', async () => {
    handOffInitOutcome({ kind: 'claim_pending', candidateWorkerId: 'c-1', phoneMasked: '•••1243', verificationSid: 'VE1' });
    render(<WorkerAccountCheckPage />);
    await expectConsentRequiredAndSent();
  });
});
