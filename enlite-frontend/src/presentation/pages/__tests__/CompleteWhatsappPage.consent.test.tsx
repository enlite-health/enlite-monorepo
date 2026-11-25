import { describe, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { claimServiceMock, expectConsentRequiredAndSent } from './claimConsent.helpers';

const mockStartClaim = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'es' } }) }));
vi.mock('@presentation/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'uid-1', email: 'g@x.com', name: 'G', roles: [] }, isAuthenticated: true, isLoading: false }),
}));
vi.mock('@infrastructure/http/AuthClaimApiService', async () => {
  const m = claimServiceMock();
  return { AuthClaimApiService: { ...m.AuthClaimApiService, startClaim: (...a: unknown[]) => mockStartClaim(...a) } };
});
vi.mock('@presentation/components/organisms/AuthNavbar', () => ({ AuthNavbar: () => <nav /> }));
vi.mock('@presentation/components/shared/PhoneInputIntl', () => ({
  PhoneInputIntl: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input data-testid="phone-input" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { CompleteWhatsappPage } from '../CompleteWhatsappPage';

describe('CompleteWhatsappPage (login com Google) — aceite no claim', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('o código só confirma com a caixa do aceite marcada, e o confirm leva lgpdOptIn: true', async () => {
    mockStartClaim.mockResolvedValue({ candidateWorkerId: 'c-1', phoneMasked: '•••1243', verificationSid: 'VE1' });
    render(<CompleteWhatsappPage />);
    fireEvent.change(screen.getByTestId('phone-input'), { target: { value: '+5491112341243' } });
    fireEvent.submit(screen.getByTestId('phone-input').closest('form')!);
    await expectConsentRequiredAndSent();
  });
});
