import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const resendEmailVerification = vi.fn();
const reloadAndRefreshToken = vi.fn();
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: class {
    resendEmailVerification = (...a: unknown[]) => resendEmailVerification(...a);
    reloadAndRefreshToken = (...a: unknown[]) => reloadAndRefreshToken(...a);
  },
}));
vi.mock('@presentation/components/features/auth/ClaimOtpModal', () => ({
  ClaimOtpModal: ({ phoneMasked, verificationSid }: { phoneMasked: string; verificationSid: string }) => (
    <div data-testid="claim-otp-modal">{phoneMasked}|{verificationSid}</div>
  ),
}));

import { WorkerInitOutcomePanel } from '../WorkerInitOutcomePanel';

const handlers = () => ({ onResolved: vi.fn(), onRetry: vi.fn(), onCancel: vi.fn() });

describe('WorkerInitOutcomePanel — o painel único do init pendente (DP-20)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('claim_pending → o MESMO ClaimOtpModal, com a máscara e o sid do init', () => {
    render(<WorkerInitOutcomePanel outcome={{ kind: 'claim_pending', phoneMasked: '•••1243', verificationSid: 'VE1' }} authUid="u" email="a@b.c" {...handlers()} />);
    expect(screen.getByTestId('claim-otp-modal').textContent).toBe('•••1243|VE1');
  });

  it('email_not_verified → "Revisá tu correo"; reenviar chama o Firebase e mostra o retorno', async () => {
    resendEmailVerification.mockResolvedValue(undefined);
    render(<WorkerInitOutcomePanel outcome={{ kind: 'email_not_verified' }} authUid="u" email="a@b.c" {...handlers()} />);
    expect(screen.getByText('claim.emailNotVerified.title')).toBeTruthy();
    fireEvent.click(screen.getByText('claim.emailNotVerified.resendButton'));
    await waitFor(() => expect(screen.getByTestId('email-not-verified-feedback').textContent).toBe('claim.emailNotVerified.resent'));
    expect(resendEmailVerification).toHaveBeenCalledTimes(1);
  });

  it('"Ya verifiqué" com o e-mail verificado → token novo e onRetry (refaz o init)', async () => {
    reloadAndRefreshToken.mockResolvedValue(true);
    const h = handlers();
    render(<WorkerInitOutcomePanel outcome={{ kind: 'email_not_verified' }} authUid="u" email="a@b.c" {...h} />);
    fireEvent.click(screen.getByText('claim.emailNotVerified.checkButton'));
    await waitFor(() => expect(h.onRetry).toHaveBeenCalledTimes(1));
  });

  it('"Ya verifiqué" sem verificar → avisa e NÃO refaz o init', async () => {
    reloadAndRefreshToken.mockResolvedValue(false);
    const h = handlers();
    render(<WorkerInitOutcomePanel outcome={{ kind: 'email_not_verified' }} authUid="u" email="a@b.c" {...h} />);
    fireEvent.click(screen.getByText('claim.emailNotVerified.checkButton'));
    await waitFor(() => expect(screen.getByTestId('email-not-verified-feedback').textContent).toBe('claim.emailNotVerified.stillNotVerified'));
    expect(h.onRetry).not.toHaveBeenCalled();
  });

  it('rate_limited → "esperá unos minutos" e o botão refaz o init', () => {
    const h = handlers();
    render(<WorkerInitOutcomePanel outcome={{ kind: 'rate_limited' }} authUid="u" email="a@b.c" {...h} />);
    expect(screen.getByText('claim.rateLimited.title')).toBeTruthy();
    fireEvent.click(screen.getByText('claim.rateLimited.retryButton'));
    expect(h.onRetry).toHaveBeenCalledTimes(1);
  });
});
