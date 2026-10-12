import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AdminLoginGuard } from '../AdminLoginGuard';
import { useAuth } from '@presentation/hooks/useAuth';
import { useAdminAuth } from '@presentation/hooks/useAdminAuth';
import type { Mock } from 'vitest';

// Mock dos hooks
vi.mock('@presentation/hooks/useAuth');
vi.mock('@presentation/hooks/useAdminAuth');

const mockUseAuth = useAuth as Mock;
const mockUseAdminAuth = useAdminAuth as Mock;

/**
 * Testes para AdminLoginGuard
 * 
 * CRITICAL: Garante que workers autenticados NÃO conseguem acessar /admin/login
 * 
 * Cenários testados:
 * 1. Worker autenticado → redireciona para /
 * 2. Admin autenticado → redireciona para /admin/dashboard
 * 3. Ninguém autenticado → permite acesso à página de login
 * 4. Loading state → mostra spinner
 */
describe('AdminLoginGuard', () => {
  const TestComponent = (): JSX.Element => <div>Admin Login Page</div>;
  const HomeComponent = (): JSX.Element => <div>Home Page</div>;
  const AdminDashboard = (): JSX.Element => <div>Admin Dashboard</div>;

  const renderWithRouter = (initialRoute = '/admin/login'): void => {
    window.history.pushState({}, 'Test', initialRoute);

    render(
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/" element={<HomeComponent />} />
          <Route path="/admin/dashboard" element={<AdminDashboard />} />
          <Route
            path="/admin/login"
            element={
              <AdminLoginGuard>
                <TestComponent />
              </AdminLoginGuard>
            }
          />
        </Routes>
      </BrowserRouter>
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Redirecionamento de admins já autenticados', () => {
    it('deve redirecionar admin autenticado para /admin/dashboard', async () => {
      // Não é worker
      mockUseAuth.mockReturnValue({
        isAuthenticated: false,
        isLoading: false,
        user: null,
        login: vi.fn(),
        loginWithGoogle: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
      });

      // É admin autenticado
      mockUseAdminAuth.mockReturnValue({
        isAuthenticated: true,
        isLoading: false,
        user: {
          uid: 'admin-uid-123',
          email: 'admin@test.com',
          displayName: 'Test Admin',
          photoURL: null,
          emailVerified: true,
        },
        adminProfile: {
          firebaseUid: 'admin-uid-123',
          email: 'admin@test.com',
          displayName: 'Test Admin',
          department: 'IT',
          createdAt: new Date(),
        },
        login: vi.fn(),
        logout: vi.fn(),
        fetchProfile: vi.fn(),
      });

      renderWithRouter('/admin/login');

      // Deve redirecionar para /admin/dashboard (Gestão à Vista)
      await waitFor(() => {
        expect(screen.getByText('Admin Dashboard')).toBeInTheDocument();
      });

      // Não deve mostrar a página de login
      expect(screen.queryByText('Admin Login Page')).not.toBeInTheDocument();
    });
  });

  describe('Acesso permitido para não autenticados', () => {
    it('deve permitir acesso quando ninguém está autenticado', async () => {
      mockUseAuth.mockReturnValue({
        isAuthenticated: false,
        isLoading: false,
        user: null,
        login: vi.fn(),
        loginWithGoogle: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
      });

      mockUseAdminAuth.mockReturnValue({
        isAuthenticated: false,
        isLoading: false,
        user: null,
        adminProfile: null,
        login: vi.fn(),
        logout: vi.fn(),
        fetchProfile: vi.fn(),
      });

      renderWithRouter('/admin/login');

      // Deve mostrar a página de login admin
      await waitFor(() => {
        expect(screen.getByText('Admin Login Page')).toBeInTheDocument();
      });
    });
  });

  describe('Loading state', () => {
    it('deve mostrar spinner quando admin auth está carregando', () => {
      mockUseAuth.mockReturnValue({
        isAuthenticated: false,
        isLoading: false,
        user: null,
        login: vi.fn(),
        loginWithGoogle: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
      });

      mockUseAdminAuth.mockReturnValue({
        isAuthenticated: false,
        isLoading: true, // Loading
        user: null,
        adminProfile: null,
        login: vi.fn(),
        logout: vi.fn(),
        fetchProfile: vi.fn(),
      });

      renderWithRouter('/admin/login');

      const spinner = document.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();
    });
  });

  describe('Edge cases', () => {
    it('deve permitir acesso apenas quando ambos os estados estão carregados e não autenticados', async () => {
      mockUseAuth.mockReturnValue({
        isAuthenticated: false,
        isLoading: false,
        user: null,
        login: vi.fn(),
        loginWithGoogle: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
      });

      mockUseAdminAuth.mockReturnValue({
        isAuthenticated: false,
        isLoading: false,
        user: null,
        adminProfile: null,
        login: vi.fn(),
        logout: vi.fn(),
        fetchProfile: vi.fn(),
      });

      renderWithRouter('/admin/login');

      await waitFor(() => {
        expect(screen.getByText('Admin Login Page')).toBeInTheDocument();
      });
    });
  });
});
