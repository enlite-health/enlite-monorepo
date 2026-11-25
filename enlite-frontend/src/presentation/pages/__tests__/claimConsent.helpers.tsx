import { expect, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

/** Mock do `confirmClaim` compartilhado pelos testes de tela do aceite no claim (spec 077). */
export const mockConfirmClaim = vi.fn();

export const claimServiceMock = () => ({
  AuthClaimApiService: {
    startClaim: vi.fn(),
    confirmClaim: (...a: unknown[]) => mockConfirmClaim(...a),
  },
});

/**
 * Com o modal do código na tela: sem a caixa, confirmar não chega à API; com a caixa, o corpo
 * do confirm leva `lgpdOptIn: true`.
 */
export async function expectConsentRequiredAndSent(): Promise<void> {
  mockConfirmClaim.mockResolvedValue({ success: true, worker: { id: 'w-1' } });
  const otp = await screen.findByTestId('otp-input');
  fireEvent.change(otp, { target: { value: '123456' } });
  const confirmBtn = screen.getByText('claim.otpModal.confirmButton').closest('button')!;

  expect(screen.getByRole('checkbox')).toBeTruthy();
  expect(confirmBtn.disabled).toBe(true);
  fireEvent.submit(otp.closest('form')!);
  expect(mockConfirmClaim).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('checkbox'));
  expect(confirmBtn.disabled).toBe(false);
  fireEvent.submit(otp.closest('form')!);
  await waitFor(() => expect(mockConfirmClaim).toHaveBeenCalledTimes(1));
  expect(mockConfirmClaim.mock.calls[0][0]).toMatchObject({ otp: '123456', lgpdOptIn: true });
}
