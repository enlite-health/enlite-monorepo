import { describe, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { claimServiceMock, expectConsentRequiredAndSent } from './claimConsent.helpers';

const initWorker = vi.fn();
vi.mock('react-router-dom', () => ({ useSearchParams: () => [new URLSearchParams()] }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k), i18n: { language: 'es' } }) }));
vi.mock('@presentation/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'uid-1', email: 'g@x.com', name: 'G', roles: [] } }),
}));
vi.mock('@presentation/hooks/useWorkerApi', () => ({
  useWorkerApi: () => ({ getProgress: vi.fn().mockRejectedValue(new Error('404')), initWorker: (...a: unknown[]) => initWorker(...a) }),
}));
vi.mock('@presentation/config/workerNavigation', () => ({ useWorkerNavItems: () => [] }));
vi.mock('@presentation/components/templates/DashboardLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock('../tabs/GeneralInfoTab', () => ({ GeneralInfoTab: () => <div /> }));
vi.mock('../tabs/ServiceAddressTab', () => ({ ServiceAddressTab: () => <div /> }));
vi.mock('../tabs/AvailabilityTab', () => ({ AvailabilityTab: () => <div /> }));
vi.mock('../tabs/DocumentsTab', () => ({ DocumentsTab: () => <div /> }));
vi.mock('@presentation/components/molecules/ProfileWizardFooter', () => ({ ProfileWizardFooter: () => <div /> }));
vi.mock('@presentation/components/organisms/ProfileCompletionSummary', () => ({ ProfileCompletionSummary: () => <div /> }));
vi.mock('@infrastructure/http/AuthClaimApiService', () => claimServiceMock());
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({ FirebaseAuthService: class {} }));

import { WorkerProfilePage } from '../WorkerProfilePage';

describe('WorkerProfilePage (perfil após login com Google) — aceite no claim', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('o código só confirma com a caixa do aceite marcada, e o confirm leva lgpdOptIn: true', async () => {
    initWorker.mockResolvedValue({ status: 'claim_pending', candidateWorkerId: 'c-1', phoneMasked: '•••1243', verificationSid: 'VE1' });
    render(<WorkerProfilePage />);
    await expectConsentRequiredAndSent();
  });
});
