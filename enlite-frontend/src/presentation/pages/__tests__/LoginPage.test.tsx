import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const navigate = vi.fn();
const resolveDestination = vi.fn();
let auth = { isAuthenticated: false, isLoading: false };

vi.mock('react-router-dom', async (orig) => ({ ...(await orig<typeof import('react-router-dom')>()), useNavigate: () => navigate }));
vi.mock('@presentation/hooks/useAuth', () => ({ useAuth: () => ({ ...auth, login: vi.fn() }) }));
vi.mock('@presentation/hooks/useAreaDestination', () => ({ useAreaDestination: () => ({ resolveDestination }) }));
vi.mock('@presentation/components/features/auth/GoogleLoginButton', () => ({ GoogleLoginButton: () => null }));

import { LoginPage } from '../LoginPage';

const mount = (url = '/login') => render(<MemoryRouter initialEntries={[url]}><LoginPage /></MemoryRouter>);

describe('LoginPage com sessão ativa', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveDestination.mockResolvedValue('/admin');
    auth = { isAuthenticated: false, isLoading: false };
  });

  it('sessão ativa → roda o hook UMA vez com o next e navega', async () => {
    auth = { isAuthenticated: true, isLoading: false };
    const { rerender } = mount('/login?next=%2Fadmin');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin', { replace: true }));
    rerender(<MemoryRouter initialEntries={['/login?next=%2Fadmin']}><LoginPage /></MemoryRouter>);
    expect(resolveDestination).toHaveBeenCalledTimes(1);
    expect(resolveDestination).toHaveBeenCalledWith('/admin');
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('sem sessão → não chama o hook nem navega', async () => {
    mount();
    await new Promise((r) => setTimeout(r, 20));
    expect(resolveDestination).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('auth ainda carregando → espera', async () => {
    auth = { isAuthenticated: true, isLoading: true };
    mount();
    await new Promise((r) => setTimeout(r, 20));
    expect(resolveDestination).not.toHaveBeenCalled();
  });

  it('destino /login nunca é navegado (sem laço)', async () => {
    auth = { isAuthenticated: true, isLoading: false };
    resolveDestination.mockResolvedValue('/login');
    mount();
    await waitFor(() => expect(resolveDestination).toHaveBeenCalledTimes(1));
    expect(navigate).not.toHaveBeenCalled();
  });
});
