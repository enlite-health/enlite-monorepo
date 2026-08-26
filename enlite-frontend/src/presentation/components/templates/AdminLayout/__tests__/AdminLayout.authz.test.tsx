import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { AdminLayout } from '../AdminLayout';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: () => ({ logout: vi.fn(), adminProfile: { role: 'admin', email: 'a@enlite.health' } }),
}));
vi.mock('@presentation/components/templates/DashboardLayout', () => ({ AppSidebar: () => <nav data-testid="sidebar" /> }));

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
});
