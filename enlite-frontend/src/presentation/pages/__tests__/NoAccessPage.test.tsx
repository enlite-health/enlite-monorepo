import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { NoAccessPage } from '../NoAccessPage';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const logout = vi.fn().mockResolvedValue(undefined);
// O mock devolve um `user` com PII só para provar que a página NÃO o renderiza.
vi.mock('@presentation/hooks/useAuth', () => ({
  useAuth: () => ({ logout, user: { email: 'pessoa@exemplo.test', displayName: 'Nome Sentinela' } }),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

function montar(reason?: 'none' | 'unavailable') {
  return render(
    <MemoryRouter>
      <NoAccessPage reason={reason} />
    </MemoryRouter>,
  );
}

describe('NoAccessPage — /no-access, genérica e sem PII', () => {
  beforeEach(() => {
    logout.mockClear();
    navigate.mockClear();
  });

  it('default (none): título e mensagem de "sem área", só chaves i18n', () => {
    montar();
    expect(screen.getByText('areas.noAccess.none.title')).toBeInTheDocument();
    expect(screen.getByText('areas.noAccess.none.message')).toBeInTheDocument();
  });

  it('unavailable: mensagem de "área ainda não disponível", nunca a de "sem área"', () => {
    montar('unavailable');
    expect(screen.getByText('areas.noAccess.unavailable.title')).toBeInTheDocument();
    expect(screen.queryByText('areas.noAccess.none.title')).not.toBeInTheDocument();
  });

  it('não renderiza e-mail nem nome da pessoa, nem link de navegação', () => {
    const { container } = montar();
    expect(container.textContent).not.toContain('pessoa@exemplo.test');
    expect(container.textContent).not.toContain('Nome Sentinela');
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('"tentar de novo" navega a /login sem sair da conta', async () => {
    montar();
    await userEvent.click(screen.getByText('areas.noAccess.retry'));
    expect(navigate).toHaveBeenCalledWith('/login');
    expect(logout).not.toHaveBeenCalled();
  });

  it('"sair" chama logout() e depois navega a /login', async () => {
    montar();
    await userEvent.click(screen.getByText('areas.noAccess.logout'));
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/login'));
  });
});
