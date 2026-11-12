import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AccessPage } from '../AccessPage';
import { AreaMembershipsPage } from '../AreaMembershipsPage';
import { PermissionHistoryPage } from '../PermissionHistoryPage';
import { cells, pagina, ANA } from './areaMembershipsFixtures';
import { postura } from './helpers';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@presentation/components/ui/skeletons', () => ({ TableSkeleton: () => <div data-testid="skeleton" /> }));
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn().mockResolvedValue('t') })),
}));
const api = { listGroups: vi.fn(), listPeople: vi.fn() };
vi.mock('@infrastructure/http/AdminPermissionsApiService', () => ({
  AdminPermissionsApiService: { listGroups: (...a: unknown[]) => api.listGroups(...a), createGroup: vi.fn() },
}));
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { listAreaPeople: (...a: unknown[]) => api.listPeople(...a) },
}));

/** O mesmo desenho de rotas do App: grupos em `/admin/access`, vínculos na rota irmã. */
function app(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin" element={<div data-testid="admin-home" />} />
        <Route path="/admin/access" element={<AccessPage />} />
        <Route path="/admin/access/area-memberships" element={<AreaMembershipsPage />} />
        <Route path="/admin/access/audit" element={<PermissionHistoryPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Painel de acessos — quem entra e em que aba (decisão 4)', () => {
  beforeEach(() => {
    api.listGroups.mockReset().mockResolvedValue([]);
    api.listPeople.mockReset().mockResolvedValue(pagina([ANA]));
  });

  it('🔴 só `area_membership:read`: a rota de grupos redireciona para Vínculos, e a moldura mostra SÓ essa aba', async () => {
    cells(['area_membership:read']);
    app('/admin/access');
    expect(await screen.findByTestId('area-memberships-section')).toBeInTheDocument();
    expect(await screen.findByText('Ana Ejemplo')).toBeInTheDocument();
    expect(screen.getByTestId('access-tab-area-memberships')).toBeInTheDocument();
    expect(screen.queryByText('admin.access.tabs.groups')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.access.tabs.features')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.access.tabs.history')).not.toBeInTheDocument();
    expect(api.listGroups).not.toHaveBeenCalled();
    expect(screen.getByTestId('read-only-notice')).toBeInTheDocument();
  });

  it('só `area_membership:read` em outra página do painel (Historial) → volta para Vínculos, sem montar a página', async () => {
    cells(['area_membership:read']);
    app('/admin/access/audit');
    expect(await screen.findByTestId('area-memberships-section')).toBeInTheDocument();
  });

  it('🔴 sem nenhuma das duas células: ambas as rotas redirecionam para a home admin e nada é chamado', async () => {
    cells(['worker:read']);
    const { unmount } = app('/admin/access');
    expect(await screen.findByTestId('admin-home')).toBeInTheDocument();
    unmount();
    app('/admin/access/area-memberships');
    expect(await screen.findByTestId('admin-home')).toBeInTheDocument();
    expect(api.listPeople).not.toHaveBeenCalled();
    expect(api.listGroups).not.toHaveBeenCalled();
  });

  it('só `permission_management:read`: a rota de vínculos redireciona para Grupos e a aba não existe', async () => {
    cells(['permission_management:read']);
    app('/admin/access/area-memberships');
    expect(await screen.findByTestId('access-groups-header')).toBeInTheDocument();
    expect(screen.queryByTestId('access-tab-area-memberships')).not.toBeInTheDocument();
    expect(api.listPeople).not.toHaveBeenCalled();
  });

  it('as duas células: as 4 abas, na ordem Grupos · Vínculos · Funciones · Historial', async () => {
    cells(['permission_management:write', 'area_membership:read']);
    app('/admin/access');
    await screen.findByTestId('access-groups-header');
    const nav = screen.getByRole('navigation');
    const labels = Array.from(nav.querySelectorAll('a')).map((a) => a.textContent);
    expect(labels).toEqual([
      'admin.access.tabs.groups',
      'admin.access.tabs.areaMemberships',
      'admin.access.tabs.features',
      'admin.access.tabs.history',
    ]);
  });

  it('o aviso de "só leitura" responde à célula da ABA: escreve em grupos, mas só lê vínculos → aviso na aba Vínculos', async () => {
    cells(['permission_management:write', 'area_membership:read']);
    const { unmount } = app('/admin/access');
    await screen.findByTestId('access-groups-header');
    expect(screen.queryByTestId('read-only-notice')).not.toBeInTheDocument();
    unmount();
    app('/admin/access/area-memberships');
    expect(await screen.findByTestId('read-only-notice')).toBeInTheDocument();
  });

  it('contrato carregando: diz que carrega, sem página e sem API', () => {
    postura('loading');
    app('/admin/access/area-memberships');
    expect(screen.getByText('admin.access.loading')).toBeInTheDocument();
    expect(api.listPeople).not.toHaveBeenCalled();
  });
});
