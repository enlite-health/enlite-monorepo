import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('@presentation/hooks/useAuth', () => ({
  useAuth: () => ({ isAuthenticated: false, isLoading: false, login: vi.fn(), sendPasswordReset: vi.fn() }),
}));
vi.mock('@presentation/hooks/useAreaDestination', () => ({ useAreaDestination: () => ({ resolveDestination: vi.fn() }) }));
vi.mock('@presentation/components/features/auth/GoogleLoginButton', () => ({ GoogleLoginButton: () => null }));
vi.mock('@presentation/components/organisms/AuthNavbar', () => ({ AuthNavbar: () => <nav /> }));

import { LoginPage } from '../LoginPage';
import { ForgotPasswordPage } from '../auth/ForgotPasswordPage';

describe('LoginPage → "¿Olvidó su contraseña?"', () => {
  it('clicar no link abre a recuperação, com o e-mail digitado pré-preenchido', () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.change(document.getElementById('email') as HTMLInputElement, { target: { value: 'ana@example.com' } });
    fireEvent.click(screen.getByText('login.forgotPassword'));

    expect(screen.getByRole('button', { name: /auth\.forgot\.submit/ })).toBeInTheDocument();
    expect((document.getElementById('forgot-email') as HTMLInputElement).value).toBe('ana@example.com');
  });

  it('o link aponta para uma rota real, não para "#"', () => {
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    expect(screen.getByTestId('forgot-password-link')).toHaveAttribute('href', '/forgot-password');
  });
});
