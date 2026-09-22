/**
 * AdminLayout — a casca do painel: sidebar + <main> rolável + <Outlet>.
 *
 * O teste que importa é o do `relative` no <main> (05/09): sem ele, um filho `position:absolute`
 * sem ancestral posicionado (Tailwind `sr-only` dentro de <th>, medido em LocalizacoesCard) tem o
 * <body> como containing block, escapa do clip do <main> e estica o documento — a operadora rola o
 * <main> até o fim e depois a página inteira rola de novo ("scroll duplo" da ficha do paciente).
 * jsdom não faz layout, então aqui se afirma a CLASSE; a medição real (html.scrollHeight ===
 * clientHeight) vive no e2e `patient-detail-scroll-unico.integration.e2e.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AdminPresenceApiService } from '@infrastructure/http/AdminPresenceApiService';

vi.mock('@infrastructure/http/AdminPresenceApiService', () => ({
  AdminPresenceApiService: { heartbeat: vi.fn() },
}));

const logout = vi.fn().mockResolvedValue(undefined);
const PERFIL_PADRAO = { displayName: 'Ana', email: 'ana@enlite.test' };
let adminProfile: { displayName?: string; email?: string } | null = PERFIL_PADRAO;
vi.mock('@presentation/hooks/useAdminAuth', () => ({ useAdminAuth: () => ({ logout, adminProfile }) }));
vi.mock('@presentation/config/adminNavigation', () => ({ useAdminNavItems: () => [] }));

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('@presentation/components/templates/DashboardLayout', () => ({
  AppSidebar: ({ userName, onMenuClick }: { userName: string; onMenuClick?: () => void }) => (
    <aside data-testid="sidebar">
      <span data-testid="sidebar-user">{userName}</span>
      <button type="button" onClick={onMenuClick} data-testid="sidebar-logout">sair</button>
    </aside>
  ),
}));

import { AdminLayout } from '../AdminLayout';

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/admin/pacientes']}>
      <Routes>
        <Route element={<AdminLayout />}>
          <Route path="/admin/pacientes" element={<div data-testid="pagina">conteúdo</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('AdminLayout', () => {
  // o perfil é variável de módulo mutada pelo último teste — volta ao padrão antes de cada um
  beforeEach(() => { adminProfile = PERFIL_PADRAO; navigate.mockClear(); logout.mockClear(); });

  it('o <main> é o único rolável e é o containing block dos filhos absolutos (relative + overflow-y-auto)', () => {
    renderLayout();
    const main = screen.getByRole('main');
    expect(main.className).toMatch(/\brelative\b/);
    expect(main.className).toMatch(/\boverflow-y-auto\b/);
    // a casca não rola: h-screen + overflow-hidden — só o <main> pode rolar
    expect(main.parentElement?.className).toMatch(/\bh-screen\b/);
    expect(main.parentElement?.className).toMatch(/\boverflow-hidden\b/);
    expect(screen.getByTestId('pagina')).toBeInTheDocument();
  });

  it('mostra o nome do admin na sidebar e, no logout, sai e vai para /admin/login', async () => {
    renderLayout();
    expect(screen.getByTestId('sidebar-user')).toHaveTextContent('Ana');
    fireEvent.click(screen.getByTestId('sidebar-logout'));
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/admin/login'));
  });

  it('sem displayName cai no e-mail; sem perfil cai em "Admin"', () => {
    adminProfile = { email: 'so.email@enlite.test' };
    const { unmount } = renderLayout();
    expect(screen.getByTestId('sidebar-user')).toHaveTextContent('so.email@enlite.test');
    unmount();
    adminProfile = null;
    renderLayout();
    expect(screen.getByTestId('sidebar-user')).toHaveTextContent('Admin');
  });

  describe('presença (spec 022, Rodada 2/R2-F)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.mocked(AdminPresenceApiService.heartbeat).mockResolvedValue(undefined);
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.clearAllMocks();
    });

    it('manda heartbeat a cada ~60s enquanto o painel admin está montado (UMA vez, aqui — não por página)', async () => {
      renderLayout();
      expect(AdminPresenceApiService.heartbeat).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
      expect(AdminPresenceApiService.heartbeat).toHaveBeenCalledTimes(1);
    });
  });
});
