/**
 * AdminRecruitmentPage.blockedLink.test.tsx
 *
 * O link "Postulaciones bloqueadas" no header do dashboard de reclutamiento
 * depende da célula `recruitment_blocked:read` (spec 024 D2/D401, 21/09/2026 —
 * era `recruitment:read`; a página destino tem a MESMA guarda, célula própria
 * porque o dado é diferente do funil de recrutamento — o link não deve
 * aparecer pra quem seria redirecionado). Com o engine desligado ele aparece,
 * como sempre apareceu (D268).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminRecruitmentPage } from '../AdminRecruitmentPage';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts?.defaultValue !== undefined) return String(opts.defaultValue);
      return key;
    },
  }),
}));

vi.mock('@hooks/recruitment/useDashboardData', () => ({
  useDashboardData: () => ({
    clickUpData: [],
    talentumData: [],
    pubData: [],
    baseData: [],
    progresoData: [],
    isLoading: true,
    error: null,
  }),
}));

vi.mock('@hooks/recruitment/useGlobalMetrics', () => ({
  useGlobalMetrics: () => ({}),
}));

vi.mock('@hooks/recruitment/useActiveCases', () => ({
  useActiveCases: () => [],
}));

vi.mock('@presentation/components/ui/skeletons', () => ({
  DashboardSkeleton: () => <div data-testid="dashboard-skeleton-mock" />,
}));

vi.mock('@presentation/components/molecules/DateRangeFilter', () => ({
  DateRangeFilter: () => null,
}));

vi.mock('@presentation/components/molecules/CaseSearchBar', () => ({
  CaseSearchBar: () => null,
}));

vi.mock('@presentation/components/organisms/ActiveCasesTable', () => ({
  ActiveCasesTable: () => null,
}));

vi.mock('@presentation/components/organisms/PublicationsBarChart', () => ({
  PublicationsBarChart: () => null,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const contrato = (permissions: string[], enforcement: AuthzContract['enforcement']): AuthzContract => ({
  uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
});

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminRecruitmentPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
});

afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AdminRecruitmentPage — link Postulaciones bloqueadas por recruitment_blocked:read', () => {
  it('COM recruitment_blocked:read (engine ON) o link aparece', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['recruitment_blocked:read'], 'on') });

    renderPage();
    const link = screen.getByTestId('blocked-attempts-link');
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/admin/recruitment/blocked-attempts');
  });

  it('SEM recruitment_blocked:read (engine ON) o link some', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'on') });

    renderPage();
    expect(screen.queryByTestId('blocked-attempts-link')).not.toBeInTheDocument();
  });

  it('enforcement "off" SEM célula nenhuma: o link aparece (régua de rollout D268)', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'off') });

    renderPage();
    expect(screen.getByTestId('blocked-attempts-link')).toBeInTheDocument();
  });

  it('sem contrato carregado: o link aparece', () => {
    renderPage();
    expect(screen.getByTestId('blocked-attempts-link')).toBeInTheDocument();
  });
});
