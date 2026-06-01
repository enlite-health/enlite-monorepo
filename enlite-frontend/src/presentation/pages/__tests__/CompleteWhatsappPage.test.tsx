import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CompleteWhatsappPage } from '../CompleteWhatsappPage';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockNavigate = vi.fn();
const mockStartClaim = vi.fn();

let mockUser: { id: string; email: string; name: string; roles: string[] } | null = {
  id: 'uid-001',
  email: 'user@example.com',
  name: 'Test User',
  roles: [],
};
let mockIsAuthenticated = true;

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'es' },
  }),
}));

vi.mock('@presentation/hooks/useAuth', () => ({
  useAuth: () => ({
    user: mockUser,
    isAuthenticated: mockIsAuthenticated,
    isLoading: false,
  }),
}));

vi.mock('@infrastructure/http/AuthClaimApiService', () => ({
  AuthClaimApiService: {
    startClaim: (...args: unknown[]) => mockStartClaim(...args),
  },
}));

vi.mock('@presentation/components/atoms/Heading', () => ({
  Heading: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
}));

vi.mock('@presentation/components/atoms/Text', () => ({
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('@presentation/components/atoms/Button', () => ({
  Button: ({ children, onClick, type, disabled, isLoading, ...rest }: any) => (
    <button
      type={type ?? 'button'}
      onClick={onClick}
      disabled={disabled || isLoading}
      {...rest}
    >
      {children}
    </button>
  ),
}));

vi.mock('@presentation/components/organisms/AuthNavbar', () => ({
  AuthNavbar: () => <nav />,
}));

vi.mock('@presentation/components/shared/PhoneInputIntl', () => ({
  PhoneInputIntl: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input
      data-testid="phone-input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

vi.mock('@presentation/components/features/auth/ClaimOtpModal', () => ({
  ClaimOtpModal: ({ open, onConfirmed, onClose }: any) =>
    open ? (
      <div data-testid="claim-otp-modal">
        <button data-testid="modal-confirm" onClick={() => onConfirmed({ id: 'w1' })}>
          confirm
        </button>
        <button data-testid="modal-close" onClick={onClose}>
          close
        </button>
      </div>
    ) : null,
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CompleteWhatsappPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = { id: 'uid-001', email: 'user@example.com', name: 'Test', roles: [] };
    mockIsAuthenticated = true;
  });

  it('redireciona para /login se nao autenticado', () => {
    mockIsAuthenticated = false;
    mockUser = null;
    render(<CompleteWhatsappPage />);
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });

  it('renderiza o formulario com campo de telefone', () => {
    render(<CompleteWhatsappPage />);
    expect(screen.getByTestId('phone-input')).toBeTruthy();
  });

  it('botao continuar desabilitado quando phone vazio', () => {
    render(<CompleteWhatsappPage />);
    const continueBtn = screen.getByText('completeWhatsapp.continueButton').closest('button')!;
    expect(continueBtn.disabled).toBe(true);
  });

  it('botao continuar habilitado quando phone preenchido', () => {
    render(<CompleteWhatsappPage />);
    fireEvent.change(screen.getByTestId('phone-input'), { target: { value: '+5491112345678' } });
    const continueBtn = screen.getByText('completeWhatsapp.continueButton').closest('button')!;
    expect(continueBtn.disabled).toBe(false);
  });

  it('navega para / quando startClaim retorna noCandidate:true', async () => {
    mockStartClaim.mockResolvedValue({ noCandidate: true });
    render(<CompleteWhatsappPage />);
    fireEvent.change(screen.getByTestId('phone-input'), { target: { value: '+5491112345678' } });
    const form = screen.getByTestId('phone-input').closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/');
    });
  });

  it('abre ClaimOtpModal quando startClaim retorna candidate', async () => {
    mockStartClaim.mockResolvedValue({
      candidateWorkerId: 'cand-1',
      phoneMasked: '+54 11 **** 5678',
      verificationSid: 'VS123',
    });
    render(<CompleteWhatsappPage />);
    fireEvent.change(screen.getByTestId('phone-input'), { target: { value: '+5491112345678' } });
    const form = screen.getByTestId('phone-input').closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(screen.getByTestId('claim-otp-modal')).toBeTruthy();
    });
  });

  it('navega para / apos confirmacao do OTP no modal', async () => {
    mockStartClaim.mockResolvedValue({
      candidateWorkerId: 'cand-1',
      phoneMasked: '+54 11 **** 5678',
      verificationSid: 'VS123',
    });
    render(<CompleteWhatsappPage />);
    fireEvent.change(screen.getByTestId('phone-input'), { target: { value: '+5491112345678' } });
    const form = screen.getByTestId('phone-input').closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => screen.getByTestId('claim-otp-modal'));
    fireEvent.click(screen.getByTestId('modal-confirm'));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('fecha modal ao cancelar sem navegar', async () => {
    mockStartClaim.mockResolvedValue({
      candidateWorkerId: 'cand-1',
      phoneMasked: '+54 11 **** 5678',
      verificationSid: 'VS123',
    });
    render(<CompleteWhatsappPage />);
    fireEvent.change(screen.getByTestId('phone-input'), { target: { value: '+5491112345678' } });
    const form = screen.getByTestId('phone-input').closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => screen.getByTestId('claim-otp-modal'));
    fireEvent.click(screen.getByTestId('modal-close'));
    await waitFor(() => {
      expect(screen.queryByTestId('claim-otp-modal')).toBeNull();
    });
    expect(mockNavigate).not.toHaveBeenCalledWith('/');
  });

  it('exibe erro quando startClaim falha', async () => {
    mockStartClaim.mockRejectedValue(new Error('Network error'));
    render(<CompleteWhatsappPage />);
    fireEvent.change(screen.getByTestId('phone-input'), { target: { value: '+5491112345678' } });
    const form = screen.getByTestId('phone-input').closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => {
      const errorEl = document.querySelector('.bg-red-50');
      expect(errorEl).toBeTruthy();
      expect(errorEl!.textContent).toContain('completeWhatsapp.startError');
    });
  });

  it('navega para / ao clicar em skipar', () => {
    render(<CompleteWhatsappPage />);
    const skipBtn = screen.getByText('completeWhatsapp.skipButton').closest('button')!;
    fireEvent.click(skipBtn);
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});
