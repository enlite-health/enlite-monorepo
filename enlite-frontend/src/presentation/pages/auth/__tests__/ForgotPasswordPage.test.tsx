import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const sendPasswordReset = vi.fn();
vi.mock('@presentation/hooks/useAuth', () => ({ useAuth: () => ({ sendPasswordReset }) }));
vi.mock('@presentation/components/organisms/AuthNavbar', () => ({ AuthNavbar: () => <nav /> }));

import { ForgotPasswordPage } from '../ForgotPasswordPage';

const firebaseError = (code: string) => Object.assign(new Error(code), { code });

const mount = (state?: { email: string }) =>
  render(
    <MemoryRouter initialEntries={[{ pathname: '/forgot-password', state }]}>
      <ForgotPasswordPage />
    </MemoryRouter>,
  );

const enviar = (email: string) => {
  fireEvent.change(document.getElementById('forgot-email') as HTMLInputElement, { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: /auth\.forgot\.submit/ }));
};

describe('ForgotPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('e-mail do login chega pré-preenchido', () => {
    mount({ email: 'ana@example.com' });
    expect((document.getElementById('forgot-email') as HTMLInputElement).value).toBe('ana@example.com');
  });

  it('sucesso → mensagem neutra e o service recebe o e-mail', async () => {
    sendPasswordReset.mockResolvedValue(undefined);
    mount();
    enviar('ana@example.com');
    expect(await screen.findByTestId('forgot-password-sent')).toHaveTextContent('auth.forgot.sentNeutral');
    expect(sendPasswordReset).toHaveBeenCalledWith('ana@example.com');
    expect(screen.queryByTestId('forgot-password-error')).toBeNull();
  });

  it.each(['auth/user-not-found', 'auth/missing-email'])('%s → a MESMA mensagem neutra do sucesso', async (code) => {
    sendPasswordReset.mockRejectedValue(firebaseError(code));
    mount();
    enviar('ninguem@example.com');
    expect(await screen.findByTestId('forgot-password-sent')).toHaveTextContent('auth.forgot.sentNeutral');
    expect(screen.queryByTestId('forgot-password-error')).toBeNull();
  });

  it('e-mail mal formatado → erro de formato, sem chamar o service', async () => {
    mount();
    enviar('isso-nao-e-email');
    expect(await screen.findByTestId('forgot-password-error')).toHaveTextContent('auth.forgot.invalidEmail');
    expect(sendPasswordReset).not.toHaveBeenCalled();
  });

  it('auth/invalid-email vindo do Firebase → erro de formato', async () => {
    sendPasswordReset.mockRejectedValue(firebaseError('auth/invalid-email'));
    mount();
    enviar('ana@example.com');
    expect(await screen.findByTestId('forgot-password-error')).toHaveTextContent('auth.forgot.invalidEmail');
    expect(screen.queryByTestId('forgot-password-sent')).toBeNull();
  });

  it('auth/too-many-requests → erro de muitas tentativas', async () => {
    sendPasswordReset.mockRejectedValue(firebaseError('auth/too-many-requests'));
    mount();
    enviar('ana@example.com');
    expect(await screen.findByTestId('forgot-password-error')).toHaveTextContent('auth.forgot.tooManyRequests');
    expect(screen.queryByTestId('forgot-password-sent')).toBeNull();
  });

  it('qualquer outro erro → falha genérica (nunca engolido) e o log não leva o e-mail', async () => {
    sendPasswordReset.mockRejectedValue(firebaseError('auth/network-request-failed'));
    mount();
    enviar('ana@example.com');
    expect(await screen.findByTestId('forgot-password-error')).toHaveTextContent('auth.forgot.genericError');
    await waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('ana@example.com');
  });

  it('há link para voltar ao login', () => {
    mount();
    expect(screen.getByTestId('forgot-password-back')).toHaveAttribute('href', '/login');
  });
});
