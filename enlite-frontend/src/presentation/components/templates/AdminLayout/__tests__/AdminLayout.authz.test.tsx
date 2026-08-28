import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { AdminLayout } from '../AdminLayout';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
const logout = vi.fn().mockResolvedValue(undefined);
vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: () => ({ logout, adminProfile: { role: 'admin', email: 'a@enlite.health' } }),
}));
vi.mock('@presentation/components/templates/DashboardLayout', () => ({
  AppSidebar: ({ onMenuClick }: { onMenuClick: () => void }) => <nav data-testid="sidebar"><button onClick={onMenuClick}>sair</button></nav>,
}));

/** Uma página com links para navegar DENTRO do mesmo router — remontar o router zeraria a memória do layout. */
function Pagina({ nome }: { nome: string }) {
  const navigate = useNavigate();
  return (
    <div>
      <span>{nome}</span>
      <button onClick={() => navigate('/admin/workers/abc')}>mesma-area</button>
      <button onClick={() => navigate('/admin/access')}>outra-area</button>
    </div>
  );
}

function montar(caminho: string) {
  return render(
    <MemoryRouter initialEntries={[caminho]}>
      <Routes>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<Pagina nome="home" />} />
          <Route path="workers" element={<Pagina nome="workers" />} />
          <Route path="workers/:id" element={<Pagina nome="worker-detalhe" />} />
          <Route path="access" element={<Pagina nome="access" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('AdminLayout — o contrato é recarregado por ÁREA', () => {
  const fetchAuthz = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    fetchAuthz.mockClear();
    useAdminAuthStore.setState({ fetchAuthz, authz: null, authzStatus: 'idle' });
  });

  it('montar não recarrega (o login já carregou); trocar de área recarrega UMA vez', async () => {
    montar('/admin/workers');
    expect(fetchAuthz).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('outra-area'));
    expect(await screen.findByText('access')).toBeInTheDocument();
    expect(fetchAuthz).toHaveBeenCalledTimes(1);
  });

  it('navegar DENTRO da mesma área não recarrega', async () => {
    montar('/admin/workers');
    await userEvent.click(screen.getByText('mesma-area'));
    expect(await screen.findByText('worker-detalhe')).toBeInTheDocument();
    expect(fetchAuthz).not.toHaveBeenCalled();
  });

  it('sair chama o logout e volta ao login', async () => {
    montar('/admin/workers');
    await userEvent.click(screen.getByText('sair'));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('a home `/admin` conta como área vazia — ir dela para outra área recarrega', async () => {
    montar('/admin');
    expect(await screen.findByText('home')).toBeInTheDocument();
    await userEvent.click(screen.getByText('outra-area'));
    await screen.findByText('access');
    expect(fetchAuthz).toHaveBeenCalledTimes(1);
  });
});
