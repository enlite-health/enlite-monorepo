import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AuthActionPage } from '../AuthActionPage';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockNavigate = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams],
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => {
      if (opts?.email) return `${key}:${opts.email}`;
      return key;
    },
    i18n: { language: 'es' },
  }),
}));

const mockVerifyPasswordResetCode = vi.fn();
const mockConfirmPasswordReset = vi.fn();
const mockSignInWithEmailAndPassword = vi.fn();

vi.mock('firebase/auth', () => ({
  verifyPasswordResetCode: (...args: unknown[]) => mockVerifyPasswordResetCode(...args),
  confirmPasswordReset: (...args: unknown[]) => mockConfirmPasswordReset(...args),
  signInWithEmailAndPassword: (...args: unknown[]) => mockSignInWithEmailAndPassword(...args),
}));

const mockGetFirebaseAuth = vi.fn(() => ({ name: 'mock-auth' }));
vi.mock('@infrastructure/config/firebase', () => ({
  getFirebaseAuth: () => mockGetFirebaseAuth(),
}));

vi.mock('@presentation/components/organisms/AuthNavbar', () => ({
  AuthNavbar: () => <nav data-testid="auth-navbar" />,
}));

vi.mock('@presentation/components/atoms', () => ({
  Typography: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('@presentation/components/atoms/Button', () => ({
  Button: ({ children, onClick, type, isLoading, ...props }: {
    children: React.ReactNode;
    onClick?: () => void;
    type?: string;
    isLoading?: boolean;
    [key: string]: unknown;
  }) => (
    <button onClick={onClick} type={(type as 'button' | 'submit' | 'reset') ?? 'button'} {...props}>
      {isLoading ? 'common.loading' : children}
    </button>
  ),
}));

vi.mock('@presentation/components/molecules', () => ({
  FormField: ({ children, label }: { children: React.ReactNode; label: string }) => (
    <div>
      <label>{label}</label>
      {children}
    </div>
  ),
  PasswordInput: ({
    id,
    value,
    onChange,
    disabled,
  }: {
    id: string;
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    disabled?: boolean;
  }) => (
    <input
      data-testid={`password-${id}`}
      id={id}
      type="password"
      value={value}
      onChange={onChange}
      disabled={disabled}
    />
  ),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setParams(params: Record<string, string>) {
  mockSearchParams = new URLSearchParams(params);
}

function renderPage() {
  return render(<AuthActionPage />);
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('AuthActionPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  // ─── 1. Mode != resetPassword ─────────────────────────────────────────────

  it('exibe card de erro "modo nao suportado" quando mode != resetPassword', async () => {
    setParams({ mode: 'verifyEmail', oobCode: 'someCode' });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('auth.action.unsupportedMode')).toBeTruthy();
    });

    expect(mockVerifyPasswordResetCode).not.toHaveBeenCalled();
  });

  // ─── 2. mode=resetPassword + verify resolve ───────────────────────────────

  it('exibe form com email quando verifyPasswordResetCode resolve', async () => {
    setParams({ mode: 'resetPassword', oobCode: 'valid-code' });
    mockVerifyPasswordResetCode.mockResolvedValueOnce('staff@enlite.health');

    renderPage();

    await waitFor(() => {
      expect(screen.getByText(/auth\.action\.titleFor/)).toBeTruthy();
    });

    expect(screen.getByTestId('password-new-password')).toBeTruthy();
    expect(screen.getByTestId('password-confirm-password')).toBeTruthy();
  });

  // ─── 3. mode=resetPassword + verify rejeita ───────────────────────────────

  it('exibe card "link invalido" quando verifyPasswordResetCode rejeita', async () => {
    setParams({ mode: 'resetPassword', oobCode: 'expired-code' });
    mockVerifyPasswordResetCode.mockRejectedValueOnce(new Error('auth/expired-action-code'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('auth.action.linkInvalid')).toBeTruthy();
    });

    expect(screen.queryByTestId('password-new-password')).toBeNull();
  });

  it('exibe card "link invalido" quando o oobCode falta na URL (sem chamar o Firebase)', async () => {
    setParams({ mode: 'resetPassword' });

    renderPage();

    await waitFor(() => {
      expect(screen.getByText('auth.action.linkInvalid')).toBeTruthy();
    });
    expect(mockVerifyPasswordResetCode).not.toHaveBeenCalled();
  });

  // ─── 4. Submit com senhas diferentes ─────────────────────────────────────

  it('exibe erro de validacao quando senhas nao coincidem, sem chamar confirmPasswordReset', async () => {
    setParams({ mode: 'resetPassword', oobCode: 'valid-code' });
    mockVerifyPasswordResetCode.mockResolvedValueOnce('staff@enlite.health');

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('password-new-password')).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId('password-new-password'), {
      target: { value: 'password123' },
    });
    fireEvent.change(screen.getByTestId('password-confirm-password'), {
      target: { value: 'differentpass' },
    });

    const form = screen.getByTestId('password-new-password').closest('form')!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText('auth.action.passwordMismatch')).toBeTruthy();
    });

    expect(mockConfirmPasswordReset).not.toHaveBeenCalled();
  });

  // ─── 5. Submit com senha muito curta ──────────────────────────────────────

  it('exibe erro de minimo de caracteres quando senha tem menos de 8 chars', async () => {
    setParams({ mode: 'resetPassword', oobCode: 'valid-code' });
    mockVerifyPasswordResetCode.mockResolvedValueOnce('staff@enlite.health');

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('password-new-password')).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId('password-new-password'), {
      target: { value: 'short' },
    });
    fireEvent.change(screen.getByTestId('password-confirm-password'), {
      target: { value: 'short' },
    });

    const form = screen.getByTestId('password-new-password').closest('form')!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText('auth.action.passwordMin')).toBeTruthy();
    });

    expect(mockConfirmPasswordReset).not.toHaveBeenCalled();
  });

  // ─── 6. Submit OK + role=admin → navigate('/admin') ──────────────────────

  it('navega para /admin quando role=admin apos submit bem-sucedido', async () => {
    setParams({ mode: 'resetPassword', oobCode: 'valid-code' });
    mockVerifyPasswordResetCode.mockResolvedValueOnce('admin@enlite.health');
    mockConfirmPasswordReset.mockResolvedValueOnce(undefined);
    mockSignInWithEmailAndPassword.mockResolvedValueOnce({
      user: {
        getIdTokenResult: vi.fn().mockResolvedValueOnce({
          claims: { role: 'admin' },
        }),
      },
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('password-new-password')).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId('password-new-password'), {
      target: { value: 'newpassword123' },
    });
    fireEvent.change(screen.getByTestId('password-confirm-password'), {
      target: { value: 'newpassword123' },
    });

    const form = screen.getByTestId('password-new-password').closest('form')!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/admin', { replace: true });
    });
  });

  // ─── 7. Submit OK + role=recruiter → navigate('/admin') ──────────────────

  it('navega para /admin quando role=recruiter', async () => {
    setParams({ mode: 'resetPassword', oobCode: 'valid-code' });
    mockVerifyPasswordResetCode.mockResolvedValueOnce('recruiter@enlite.health');
    mockConfirmPasswordReset.mockResolvedValueOnce(undefined);
    mockSignInWithEmailAndPassword.mockResolvedValueOnce({
      user: {
        getIdTokenResult: vi.fn().mockResolvedValueOnce({
          claims: { role: 'recruiter' },
        }),
      },
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('password-new-password')).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId('password-new-password'), {
      target: { value: 'newpassword123' },
    });
    fireEvent.change(screen.getByTestId('password-confirm-password'), {
      target: { value: 'newpassword123' },
    });

    const form = screen.getByTestId('password-new-password').closest('form')!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/admin', { replace: true });
    });
  });

  // ─── 8. Submit OK + role ausente → navigate('/') ─────────────────────────

  it('navega para / quando role e undefined (worker)', async () => {
    setParams({ mode: 'resetPassword', oobCode: 'valid-code' });
    mockVerifyPasswordResetCode.mockResolvedValueOnce('worker@example.com');
    mockConfirmPasswordReset.mockResolvedValueOnce(undefined);
    mockSignInWithEmailAndPassword.mockResolvedValueOnce({
      user: {
        getIdTokenResult: vi.fn().mockResolvedValueOnce({
          claims: {},
        }),
      },
    });

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('password-new-password')).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId('password-new-password'), {
      target: { value: 'newpassword123' },
    });
    fireEvent.change(screen.getByTestId('password-confirm-password'), {
      target: { value: 'newpassword123' },
    });

    const form = screen.getByTestId('password-new-password').closest('form')!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });
  });

  // ─── 8b. D294: `account_type` vence o papel ───────────────────────────────

  async function submitComClaims(claims: Record<string, string>): Promise<void> {
    setParams({ mode: 'resetPassword', oobCode: 'valid-code' });
    mockVerifyPasswordResetCode.mockResolvedValueOnce('alguem@example.com');
    mockConfirmPasswordReset.mockResolvedValueOnce(undefined);
    mockSignInWithEmailAndPassword.mockResolvedValueOnce({
      user: { getIdTokenResult: vi.fn().mockResolvedValueOnce({ claims }) },
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('password-new-password')).toBeTruthy();
    });
    fireEvent.change(screen.getByTestId('password-new-password'), { target: { value: 'newpassword123' } });
    fireEvent.change(screen.getByTestId('password-confirm-password'), { target: { value: 'newpassword123' } });
    fireEvent.submit(screen.getByTestId('password-new-password').closest('form')!);
  }

  it('account_type=staff → /admin, mesmo sem role', async () => {
    await submitComClaims({ account_type: 'staff' });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/admin', { replace: true });
    });
  });

  it('account_type=worker → /, mesmo com role=admin (o tipo declarado vence a ponte)', async () => {
    await submitComClaims({ account_type: 'worker', role: 'admin' });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });
  });

  // ─── 9. confirmPasswordReset falha → erro inline, form visivel ────────────

  it('exibe erro inline e mantem form visivel quando confirmPasswordReset falha', async () => {
    setParams({ mode: 'resetPassword', oobCode: 'valid-code' });
    mockVerifyPasswordResetCode.mockResolvedValueOnce('staff@enlite.health');
    mockConfirmPasswordReset.mockRejectedValueOnce(new Error('auth/weak-password'));

    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('password-new-password')).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId('password-new-password'), {
      target: { value: 'newpassword123' },
    });
    fireEvent.change(screen.getByTestId('password-confirm-password'), {
      target: { value: 'newpassword123' },
    });

    const form = screen.getByTestId('password-new-password').closest('form')!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(screen.getByText('auth.action.genericError')).toBeTruthy();
    });

    // Form ainda visível
    expect(screen.getByTestId('password-new-password')).toBeTruthy();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
