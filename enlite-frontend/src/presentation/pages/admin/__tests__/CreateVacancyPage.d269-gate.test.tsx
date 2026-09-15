/**
 * CreateVacancyPage.d269-gate.test.tsx
 *
 * D269 (rodada 6 do gate): `/admin/vacancies/new` é alcançável DIRETO por URL
 * — não só pelo botão "Nueva Vacante" do listado (já coberto em
 * `admin-access-buttons-vacancies.integration.e2e.ts`). Sem `vacancy:write`,
 * a PORTA fecha (`<Navigate to="/admin/vacancies" replace />` antes do form),
 * não só o botão de salvar.
 *
 * Mesmo padrão de mock da store usado em `AdminUsersPage.test.tsx`/
 * `adminNavigation.d269-cells.test.tsx`: `useAdminAuthStore.setState` com
 * `enforcement`/`permissions` controlados por teste.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// Boundary do component: nenhum destes é chamado no mount de `/admin/vacancies/new`
// sem caso selecionado (create mode, sem routeVacancyId) — stubs só pra não
// quebrar o import.
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getVacancyById: vi.fn(),
    listDraftsForPatient: vi.fn().mockResolvedValue([]),
    listVacanciesByAddress: vi.fn().mockResolvedValue([]),
    generateAIContent: vi.fn(),
    getCasesForSelect: vi.fn().mockResolvedValue([]),
    getNextVacancyNumber: vi.fn().mockResolvedValue(1),
    createVacancy: vi.fn(),
    updateVacancy: vi.fn(),
    updateVacancyMeetLinks: vi.fn(),
  },
}));

import CreateVacancyPage from '../CreateVacancyPage';

function VacanciesListMarker() {
  return <span>vacancies-list-marker</span>;
}

function montar(caminho = '/admin/vacancies/new') {
  return render(
    <MemoryRouter initialEntries={[caminho]}>
      <Routes>
        <Route path="/admin/vacancies" element={<VacanciesListMarker />} />
        <Route path="/admin/vacancies/new" element={<CreateVacancyPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const contrato = (permissions: string[], enforcement: AuthzContract['enforcement']): AuthzContract => ({
  uid: 'u',
  tenantId: 't',
  status: 'ACTIVE',
  permissions,
  countries: [],
  groups: [],
  features: {},
  enforcement,
});

describe('CreateVacancyPage — D269 gate de rota (vacancy:write)', () => {
  afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('enforcement "on" SEM vacancy:write → redireciona para /admin/vacancies (a porta fecha, não só o botão)', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'on') });
    montar();

    expect(screen.getByText('vacancies-list-marker')).toBeInTheDocument();
    expect(screen.queryByTestId('create-vacancy-save-btn')).not.toBeInTheDocument();
  });

  it('enforcement "on" COM vacancy:write → renderiza o form, com o botão salvar', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['vacancy:create'], 'on') });
    montar();

    expect(screen.queryByText('vacancies-list-marker')).not.toBeInTheDocument();
    expect(screen.getByTestId('create-vacancy-save-btn')).toBeInTheDocument();
  });

  it('enforcement "off" (sem contrato) → comportamento atual: form acessível, sem redirect', () => {
    montar();

    expect(screen.queryByText('vacancies-list-marker')).not.toBeInTheDocument();
    expect(screen.getByTestId('create-vacancy-save-btn')).toBeInTheDocument();
  });
});
