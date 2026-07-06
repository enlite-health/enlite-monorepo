/**
 * AdminRecruitmentPage.blockedLink.test.tsx
 *
 * O link "Postulaciones bloqueadas" no header do dashboard de reclutamiento
 * é admin-only (a página destino tem guard de role; o link não deve aparecer
 * pra quem seria redirecionado).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminRecruitmentPage } from '../AdminRecruitmentPage';
import { EnliteRole } from '@domain/entities/EnliteRole';
import type { AdminUser } from '@domain/entities/AdminUser';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts?.defaultValue !== undefined) return String(opts.defaultValue);
      return key;
    },
  }),
}));

const mockUseAdminAuth = vi.fn();

vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: () => mockUseAdminAuth(),
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

const ADMIN_PROFILE: AdminUser = {
  firebaseUid: 'uid-admin',
  email: 'admin@enlite.health',
  displayName: 'Admin User',
  role: EnliteRole.ADMIN,
  department: null,
  lastLoginAt: null,
  loginCount: 1,
  createdAt: '2026-01-01T00:00:00Z',
};

const RECRUITER_PROFILE: AdminUser = {
  ...ADMIN_PROFILE,
  role: EnliteRole.RECRUITER,
  email: 'recruiter@enlite.health',
};

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminRecruitmentPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AdminRecruitmentPage — link Postulaciones bloqueadas admin-only', () => {
  it('admin vê o link pra postulaciones bloqueadas', () => {
    mockUseAdminAuth.mockReturnValue({
      adminProfile: ADMIN_PROFILE,
      isAuthenticated: true,
      isLoading: false,
    });

    renderPage();
    const link = screen.getByTestId('blocked-attempts-link');
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/admin/recruitment/blocked-attempts');
  });

  it('não-admin (RECRUITER) NÃO vê o link', () => {
    mockUseAdminAuth.mockReturnValue({
      adminProfile: RECRUITER_PROFILE,
      isAuthenticated: true,
      isLoading: false,
    });

    renderPage();
    expect(screen.queryByTestId('blocked-attempts-link')).not.toBeInTheDocument();
  });

  it('sem perfil carregado (null) NÃO vê o link', () => {
    mockUseAdminAuth.mockReturnValue({
      adminProfile: null,
      isAuthenticated: false,
      isLoading: true,
    });

    renderPage();
    expect(screen.queryByTestId('blocked-attempts-link')).not.toBeInTheDocument();
  });
});
