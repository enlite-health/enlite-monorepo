import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminLoginPage } from '../AdminLoginPage';

/**
 * Quem entra no painel admin (Google ou e-mail/senha) começa em Gestão à Vista
 * (`/admin/dashboard`), e não no índice `/admin` (tela de Usuários).
 */
const mockNavigate = vi.fn();
const mockLogin = vi.fn();
const mockLoginWithGoogle = vi.fn();
const mockTrace = { step: vi.fn(), end: vi.fn(), fail: vi.fn() };

vi.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));
vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: () => ({ login: mockLogin, loginWithGoogle: mockLoginWithGoogle }),
}));
vi.mock('@presentation/stores/adminAuthStore', () => ({
  useAdminAuthStore: { getState: () => ({ adminProfile: { id: 'a1' }, logout: vi.fn() }) },
}));
vi.mock('@infrastructure/observability/authTrace', () => ({
  startAuthTrace: () => mockTrace,
}));
vi.mock('@presentation/components/organisms/AuthNavbar', () => ({ AuthNavbar: () => null }));

describe('AdminLoginPage — destino após o login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogin.mockResolvedValue(undefined);
    mockLoginWithGoogle.mockResolvedValue(undefined);
  });

  it('login com Google navega para /admin/dashboard', async () => {
    const { container } = render(<AdminLoginPage />);
    fireEvent.click(container.querySelector('button[type="button"]:not([aria-label])') as HTMLButtonElement);

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/admin/dashboard'));
    expect(mockTrace.step).toHaveBeenCalledWith('redirect', { to: '/admin/dashboard' });
  });

  it('login com e-mail e senha navega para /admin/dashboard', async () => {
    const { container } = render(<AdminLoginPage />);
    fireEvent.change(container.querySelector('#admin-email') as HTMLInputElement, { target: { value: 'a@enlite.health' } });
    fireEvent.change(container.querySelector('#admin-password') as HTMLInputElement, { target: { value: 'segredo123' } });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/admin/dashboard'), { timeout: 3000 });
    expect(mockLogin).toHaveBeenCalled();
    expect(mockTrace.step).toHaveBeenCalledWith('redirect', { to: '/admin/dashboard' });
    expect(screen.queryByText(/Acesso negado/)).toBeNull();
  });
});
