import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PhoneVerificationModal } from './PhoneVerificationModal';
import { WorkerApiService } from '@infrastructure/http/WorkerApiService';
import { ApiError } from '@infrastructure/http/ApiError';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => (opts?.phoneMasked ? `${key}:${opts.phoneMasked}` : key),
    i18n: { language: 'es' },
  }),
}));

vi.mock('@infrastructure/http/WorkerApiService', () => ({
  WorkerApiService: {
    startPhoneVerification: vi.fn(),
    confirmPhoneVerification: vi.fn(),
  },
}));

const SENT = { status: 'SENT', challengeId: 'ch-1', phoneMasked: '+54 9 11 ****-5663', resendAfterSec: 60, expiresInSec: 600 };

function apiError(code: string, status: number, extra: Record<string, unknown> = {}): ApiError {
  return new ApiError({ success: false, error: code, code, ...extra }, status);
}

async function renderAteOCodigo(props: Partial<React.ComponentProps<typeof PhoneVerificationModal>> = {}) {
  const onVerified = vi.fn();
  const onPhoneInUse = vi.fn();
  const onClose = vi.fn();
  render(
    <PhoneVerificationModal
      open
      mode="verify"
      currentPhone="+5491151265663"
      onVerified={onVerified}
      onPhoneInUse={onPhoneInUse}
      onClose={onClose}
      {...props}
    />,
  );
  fireEvent.click(screen.getByTestId('phone-verification-send'));
  const input = (await screen.findByTestId('phone-verification-code')) as HTMLInputElement;
  return { input, onVerified, onPhoneInUse, onClose };
}

describe('PhoneVerificationModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(WorkerApiService.startPhoneVerification).mockResolvedValue(SENT as never);
  });

  it('T-F3c-146 código certo: chama confirm com o desafio e avisa que verificou', async () => {
    vi.mocked(WorkerApiService.confirmPhoneVerification).mockResolvedValue({ status: 'VERIFIED', phoneMasked: 'x', verifiedAt: '2026-11-24T00:00:00Z' });
    const { input, onVerified } = await renderAteOCodigo();

    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('phone-verification-confirm'));

    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(WorkerApiService.startPhoneVerification).toHaveBeenCalledWith('+5491151265663');
    expect(WorkerApiService.confirmPhoneVerification).toHaveBeenCalledWith({
      phone: '+5491151265663',
      challengeId: 'ch-1',
      code: '123456',
    });
  });

  it('T-F3c-146 INVALID_OTP: mostra o erro e limpa o campo', async () => {
    vi.mocked(WorkerApiService.confirmPhoneVerification).mockRejectedValue(apiError('INVALID_OTP', 400));
    const { input, onVerified } = await renderAteOCodigo();

    fireEvent.change(input, { target: { value: '000000' } });
    fireEvent.click(screen.getByTestId('phone-verification-confirm'));

    expect(await screen.findByText('phoneVerification.modal.errorInvalidOtp')).toBeTruthy();
    expect((screen.getByTestId('phone-verification-code') as HTMLInputElement).value).toBe('');
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('T-F3c-146 PHONE_IN_USE: entrega o número a quem abre o unir contas', async () => {
    vi.mocked(WorkerApiService.startPhoneVerification).mockRejectedValue(apiError('PHONE_IN_USE', 409));
    const onVerified = vi.fn();
    const onPhoneInUse = vi.fn();
    render(
      <PhoneVerificationModal open mode="verify" currentPhone="+5491151265663" onVerified={onVerified} onPhoneInUse={onPhoneInUse} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('phone-verification-send'));

    await waitFor(() => expect(onPhoneInUse).toHaveBeenCalledWith('+5491151265663'));
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('T-F3c-146 CLAIM_CONFLICT: "Hablar con el equipo" com o handoffUrl do servidor', async () => {
    vi.mocked(WorkerApiService.confirmPhoneVerification).mockRejectedValue(
      apiError('CLAIM_CONFLICT', 409, { handoffUrl: 'https://wa.me/549000?text=ref-abc' }),
    );
    const { input } = await renderAteOCodigo();

    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('phone-verification-confirm'));

    const link = (await screen.findByTestId('phone-verification-team-link')) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://wa.me/549000?text=ref-abc');
    expect(link.textContent).toBe('phoneVerification.modal.teamButton');
  });
});
