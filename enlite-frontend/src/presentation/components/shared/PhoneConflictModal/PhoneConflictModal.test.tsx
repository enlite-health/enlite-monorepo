/**
 * PhoneConflictModal.test.tsx — unit do fluxo v2 (API mockada).
 *
 * Cobre:
 *  - passo colisão: número por extenso + email mascarado + 3 saídas
 *  - SMS só dispara no clique em "vincular" (lookup NÃO chama start)
 *  - "sem acesso" → orientação (não é beco) e fecha pra usar outro número
 *  - OTP: reenvio chama start de novo; erro de código mostra mensagem
 *  - confirm com conflitos → FieldChoiceList com default = suggested
 *  - finalize com as escolhas → resumo com contagens
 *  - REQUIRES_REVIEW → passo de revisão humana
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PhoneConflictModal } from './PhoneConflictModal';

const mockStart = vi.fn();
const mockConfirm = vi.fn();
const mockFinalize = vi.fn();

vi.mock('@infrastructure/http/WorkerApiService', () => ({
  WorkerApiService: {
    startAccountLink: (...a: unknown[]) => mockStart(...a),
    confirmAccountLink: (...a: unknown[]) => mockConfirm(...a),
    finalizeAccountLink: (...a: unknown[]) => mockFinalize(...a),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultOrOpts?: unknown, maybeOpts?: Record<string, unknown>) => {
      const opts = (typeof defaultOrOpts === 'object' ? defaultOrOpts : maybeOpts) as Record<string, unknown> | undefined;
      if (opts && ('applications' in opts || 'phoneMasked' in opts)) {
        return `${key}:${Object.values(opts).filter(v => typeof v !== 'string' || !v.includes('.')).join(',')}`;
      }
      return key;
    },
    i18n: { language: 'es' },
  }),
}));

const CURRENT = 'id-current';
const OTHER = 'id-other';

const baseProps = {
  open: true,
  phoneEntered: '+541133336012',
  lookupData: { otherEmailMasked: 'kete•••@gmail.com', phoneMasked: '•••••••••6012' },
  onClose: vi.fn(),
  onLinked: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockStart.mockResolvedValue({ verificationSid: 'VE-1', phoneMasked: '•••••••••6012' });
});

describe('PhoneConflictModal — passo colisão', () => {
  it('mostra número por extenso, email mascarado e 3 saídas; SEM SMS ainda', () => {
    render(<PhoneConflictModal {...baseProps} />);
    expect(screen.getByTestId('phone-conflict-phone').textContent).toBe('+541133336012');
    expect(screen.getByTestId('phone-conflict-email').textContent).toBe('kete•••@gmail.com');
    expect(screen.getByTestId('phone-conflict-link-button')).toBeTruthy();
    expect(screen.getByTestId('phone-conflict-no-access-button')).toBeTruthy();
    expect(screen.getByTestId('phone-conflict-support-link')).toBeTruthy();
    expect(mockStart).not.toHaveBeenCalled(); // contrato v2: lookup não envia SMS
  });

  it('"sem acesso" abre orientação e "usar outro número" fecha a modal', () => {
    render(<PhoneConflictModal {...baseProps} />);
    fireEvent.click(screen.getByTestId('phone-conflict-no-access-button'));
    expect(screen.getByTestId('phone-conflict-step-no-access')).toBeTruthy();
    fireEvent.click(screen.getByTestId('phone-conflict-no-access-close'));
    expect(baseProps.onClose).toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });
});

describe('PhoneConflictModal — OTP', () => {
  it('"vincular" dispara o start (SÓ aqui o SMS sai) e abre o passo OTP', async () => {
    render(<PhoneConflictModal {...baseProps} />);
    fireEvent.click(screen.getByTestId('phone-conflict-link-button'));
    await waitFor(() => expect(screen.getByTestId('phone-conflict-step-otp')).toBeTruthy());
    expect(mockStart).toHaveBeenCalledWith('+541133336012');
  });

  it('reenviar chama start de novo e mostra "reenviado"', async () => {
    render(<PhoneConflictModal {...baseProps} />);
    fireEvent.click(screen.getByTestId('phone-conflict-link-button'));
    await waitFor(() => screen.getByTestId('account-link-otp-resend'));
    fireEvent.click(screen.getByTestId('account-link-otp-resend'));
    await waitFor(() => expect(mockStart).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('account-link-otp-resent')).toBeTruthy();
  });

  it('código inválido mostra erro sem fechar', async () => {
    const { ApiError } = await import('@infrastructure/http/ApiError');
    mockConfirm.mockRejectedValue(new ApiError({ success: false, error: 'x', code: 'INVALID_OTP' }, 400));
    render(<PhoneConflictModal {...baseProps} />);
    fireEvent.click(screen.getByTestId('phone-conflict-link-button'));
    await waitFor(() => screen.getByTestId('account-link-otp-input'));
    fireEvent.change(screen.getByTestId('account-link-otp-input'), { target: { value: '111111' } });
    fireEvent.click(screen.getByTestId('account-link-otp-confirm'));
    await waitFor(() => expect(screen.getByTestId('account-link-otp-error')).toBeTruthy());
  });
});

describe('PhoneConflictModal — conflitos → finalize → resumo', () => {
  it('conflitos com default = suggested; finalize envia as escolhas; resumo com contagens', async () => {
    mockConfirm.mockResolvedValue({
      status: 'conflicts',
      conflicts: [{ field: 'profession', values: { [CURRENT]: 'AT', [OTHER]: 'CAREGIVER' }, is_encrypted: false, has_conflict: true, suggested: CURRENT }],
      linkToken: 'LT-1',
      accounts: { current: CURRENT, other: OTHER },
    });
    mockFinalize.mockResolvedValue({
      status: 'merged',
      recovered: { worker_job_applications: 2, worker_documents: 1 },
      workerStatus: 'REGISTERED',
    });

    render(<PhoneConflictModal {...baseProps} />);
    fireEvent.click(screen.getByTestId('phone-conflict-link-button'));
    await waitFor(() => screen.getByTestId('account-link-otp-input'));
    fireEvent.change(screen.getByTestId('account-link-otp-input'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('account-link-otp-confirm'));

    await waitFor(() => expect(screen.getByTestId('phone-conflict-step-conflicts')).toBeTruthy());
    // default = suggested (conta atual) já selecionado
    expect(screen.getByTestId(`conflict-profession-${CURRENT}`).getAttribute('aria-pressed')).toBe('true');

    // escolhe a conta anterior e finaliza
    fireEvent.click(screen.getByTestId(`conflict-profession-${OTHER}`));
    fireEvent.click(screen.getByTestId('account-link-conflicts-confirm'));

    await waitFor(() => expect(screen.getByTestId('phone-conflict-step-summary')).toBeTruthy());
    expect(mockFinalize).toHaveBeenCalledWith({ linkToken: 'LT-1', fieldChoices: { profession: OTHER } });
    expect(baseProps.onLinked).toHaveBeenCalled();
    expect(screen.getByTestId('account-link-summary-text').textContent).toContain('2,1');
  });

  it('sem conflito → resumo direto', async () => {
    mockConfirm.mockResolvedValue({ status: 'merged', recovered: {}, workerStatus: 'REGISTERED' });
    render(<PhoneConflictModal {...baseProps} />);
    fireEvent.click(screen.getByTestId('phone-conflict-link-button'));
    await waitFor(() => screen.getByTestId('account-link-otp-input'));
    fireEvent.change(screen.getByTestId('account-link-otp-input'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('account-link-otp-confirm'));
    await waitFor(() => expect(screen.getByTestId('phone-conflict-step-summary')).toBeTruthy());
  });

  it('REQUIRES_REVIEW → passo de revisão humana, sem resumo', async () => {
    mockConfirm.mockResolvedValue({ status: 'REQUIRES_REVIEW' });
    render(<PhoneConflictModal {...baseProps} />);
    fireEvent.click(screen.getByTestId('phone-conflict-link-button'));
    await waitFor(() => screen.getByTestId('account-link-otp-input'));
    fireEvent.change(screen.getByTestId('account-link-otp-input'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('account-link-otp-confirm'));
    await waitFor(() => expect(screen.getByTestId('phone-conflict-step-review')).toBeTruthy());
    expect(baseProps.onLinked).not.toHaveBeenCalled();
  });
});
