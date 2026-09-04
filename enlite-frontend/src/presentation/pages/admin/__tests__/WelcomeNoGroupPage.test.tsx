import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { WelcomeNoGroupPage } from '../WelcomeNoGroupPage';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const logout = vi.fn().mockResolvedValue(undefined);
vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: () => ({ logout }),
}));

function montar() {
  return render(
    <MemoryRouter>
      <WelcomeNoGroupPage />
    </MemoryRouter>,
  );
}

describe('WelcomeNoGroupPage — genérica, sem menu operacional', () => {
  beforeEach(() => logout.mockClear());

  it('mostra título e mensagem genéricos (chaves i18n, sem nome/e-mail de ninguém)', () => {
    montar();
    expect(screen.getByText('admin.welcomeNoGroup.title')).toBeInTheDocument();
    expect(screen.getByText('admin.welcomeNoGroup.message')).toBeInTheDocument();
  });

  it('não renderiza nenhum link de navegação operacional (sem menu)', () => {
    montar();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument();
  });

  it('o botão de logout chama logout() e não lança', async () => {
    montar();
    await userEvent.click(screen.getByText('admin.welcomeNoGroup.logout'));
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });
});
