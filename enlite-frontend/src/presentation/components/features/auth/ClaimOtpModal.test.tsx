import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ClaimOtpModal } from './ClaimOtpModal';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockConfirm = vi.fn();
const mockClearError = vi.fn();

let mockIsLoading = false;
let mockErrorCode: string | null = null;

vi.mock('@presentation/hooks/useClaimConfirm', () => ({
  useClaimConfirm: () => ({
    isLoading: mockIsLoading,
    errorCode: mockErrorCode,
    confirm: mockConfirm,
    clearError: mockClearError,
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => {
      if (opts?.phoneMasked) return `${key}:${opts.phoneMasked}`;
      return key;
    },
    i18n: { language: 'es' },
  }),
}));

vi.mock('@presentation/components/atoms/Heading', () => ({
  Heading: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('@presentation/components/atoms/Text', () => ({
  Text: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
}));

vi.mock('@presentation/components/atoms/Label', () => ({
  Label: ({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}));

vi.mock('@presentation/components/atoms/Button', () => ({
  Button: ({ children, onClick, type, disabled, isLoading, ...rest }: any) => (
    <button
      type={type ?? 'button'}
      onClick={onClick}
      disabled={disabled || isLoading}
      data-loading={isLoading}
      {...rest}
    >
      {children}
    </button>
  ),
}));

// ── Default props ─────────────────────────────────────────────────────────────

const defaultProps = {
  open: true,
  phoneMasked: '+54 11 **** 5678',
  verificationSid: 'VE_sid_123',
  candidateWorkerId: 'cand-worker-456',
  authUid: 'auth-uid-789',
  email: 'test@example.com',
  onConfirmed: vi.fn(),
  onClose: vi.fn(),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ClaimOtpModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsLoading = false;
    mockErrorCode = null;
  });

  it('nao renderiza quando open=false', () => {
    render(<ClaimOtpModal {...defaultProps} open={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renderiza o dialog quando open=true', () => {
    render(<ClaimOtpModal {...defaultProps} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('exibe o titulo e subtitulo com phoneMasked interpolado', () => {
    render(<ClaimOtpModal {...defaultProps} />);
    expect(screen.getByText('claim.otpModal.title')).toBeTruthy();
    expect(screen.getByText(/claim.otpModal.subtitle/)).toBeTruthy();
  });

  it('aceita apenas digitos no input OTP', () => {
    render(<ClaimOtpModal {...defaultProps} />);
    const input = screen.getByTestId('otp-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc123xyz' } });
    expect(input.value).toBe('123');
  });

  it('limita input a 6 digitos', () => {
    render(<ClaimOtpModal {...defaultProps} />);
    const input = screen.getByTestId('otp-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1234567890' } });
    expect(input.value).toBe('123456');
  });

  it('botao confirmar fica desabilitado com menos de 6 digitos', () => {
    render(<ClaimOtpModal {...defaultProps} />);
    const input = screen.getByTestId('otp-input');
    fireEvent.change(input, { target: { value: '123' } });
    const confirmBtn = screen.getByText('claim.otpModal.confirmButton').closest('button')!;
    expect(confirmBtn.disabled).toBe(true);
  });

  it('chama confirm ao submeter com 6 digitos', async () => {
    mockConfirm.mockResolvedValue({ id: 'worker-1', email: 'test@example.com' });
    render(<ClaimOtpModal {...defaultProps} />);
    const input = screen.getByTestId('otp-input');
    fireEvent.change(input, { target: { value: '123456' } });
    const form = input.closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalledWith('123456');
    });
  });

  it('chama onConfirmed com o worker quando confirm retorna sucesso', async () => {
    const worker = { id: 'worker-1', email: 'test@example.com' };
    mockConfirm.mockResolvedValue(worker);
    render(<ClaimOtpModal {...defaultProps} />);
    const input = screen.getByTestId('otp-input');
    fireEvent.change(input, { target: { value: '123456' } });
    const form = input.closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(defaultProps.onConfirmed).toHaveBeenCalledWith(worker);
    });
  });

  it('exibe erro INVALID_OTP quando errorCode=INVALID_OTP', () => {
    mockErrorCode = 'INVALID_OTP';
    render(<ClaimOtpModal {...defaultProps} />);
    expect(screen.getByText('claim.otpModal.errorInvalid')).toBeTruthy();
  });

  it('exibe erro EXPIRED_OTP quando errorCode=EXPIRED_OTP', () => {
    mockErrorCode = 'EXPIRED_OTP';
    render(<ClaimOtpModal {...defaultProps} />);
    expect(screen.getByText('claim.otpModal.errorExpired')).toBeTruthy();
  });

  it('exibe erro CANDIDATE_NOT_FOUND quando errorCode=CANDIDATE_NOT_FOUND', () => {
    mockErrorCode = 'CANDIDATE_NOT_FOUND';
    render(<ClaimOtpModal {...defaultProps} />);
    expect(screen.getByText('claim.otpModal.errorNotFound')).toBeTruthy();
  });

  it('chama clearError ao digitar novo codigo com erro ativo', () => {
    mockErrorCode = 'INVALID_OTP';
    render(<ClaimOtpModal {...defaultProps} />);
    const input = screen.getByTestId('otp-input');
    fireEvent.change(input, { target: { value: '1' } });
    expect(mockClearError).toHaveBeenCalled();
  });

  it('chama onClose ao clicar em cancelar', () => {
    render(<ClaimOtpModal {...defaultProps} />);
    const cancelBtn = screen.getByText('claim.otpModal.cancelButton').closest('button')!;
    fireEvent.click(cancelBtn);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('chama onClose ao clicar no backdrop', () => {
    render(<ClaimOtpModal {...defaultProps} />);
    const backdrop = document.querySelector('[aria-hidden="true"]') as HTMLElement;
    fireEvent.click(backdrop);
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('nao chama confirm quando confirm retorna null', async () => {
    mockConfirm.mockResolvedValue(null);
    render(<ClaimOtpModal {...defaultProps} />);
    const input = screen.getByTestId('otp-input');
    fireEvent.change(input, { target: { value: '123456' } });
    const form = input.closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalled();
    });
    expect(defaultProps.onConfirmed).not.toHaveBeenCalled();
  });
});
