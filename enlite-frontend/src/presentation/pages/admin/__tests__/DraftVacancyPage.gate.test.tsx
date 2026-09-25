/**
 * DraftVacancyPage.gate.test.tsx — gate parcial da Fase 2 (25/09, rodada 2), achado #1.
 *
 * `useHasCell` (usado antes) não olha `enforcement` — com o engine fora de `on` (prd hoje) a
 * tela mostraria "No visible para tu perfil" num campo que o backend já devolveu CHEIO
 * (`patientContainerAccess.ts:123`: `cells===null` → devolve o dado, sem redigir). A regra
 * certa (`useContainerAccess`, D286): "No visible" só quando `enforcement==='on'` E a célula
 * falta; caso contrário o valor do GET manda. Molde: `VacancyDetailPage.gate.test.tsx`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'draft-vacancy-id' }),
    useNavigate: () => mockNavigate,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@hooks/admin/useVacancyDetail', () => ({
  useVacancyDetail: vi.fn(),
}));

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getPatientById: vi.fn().mockResolvedValue({ contractedServices: [] }),
  },
}));

vi.mock('@presentation/components/ui/skeletons', () => ({
  DetailSkeleton: () => <div data-testid="detail-skeleton">Loading...</div>,
}));

// Só o card "Lo que ya sabemos" importa aqui — captura exatamente o valor que a PÁGINA decidiu
// para `addressDisplayValue`, sem depender do resto do card (FieldPairGrid, grade de horário…).
vi.mock(
  '@presentation/components/features/admin/VacancyDetail/DraftVacancyKnownCard',
  () => ({
    DraftVacancyKnownCard: ({ addressDisplayValue }: { addressDisplayValue: string }) => (
      <div data-testid="address-value">{addressDisplayValue}</div>
    ),
  }),
);

vi.mock(
  '@presentation/components/features/admin/VacancyDetail/DraftVacancyTodoCard',
  () => ({
    DraftVacancyTodoCard: () => <div data-testid="todo-card">TodoCard</div>,
  }),
);

import { useVacancyDetail } from '@hooks/admin/useVacancyDetail';
import DraftVacancyPage from '../DraftVacancyPage';

const ENDERECO_REAL = 'Av. Corrientes 1234, CABA';

const mockVacancy = {
  id: 'draft-vacancy-id',
  is_draft: true,
  status: 'SEARCHING',
  country: 'AR',
  created_at: '2026-09-25T00:00:00Z',
  updated_at: '2026-09-25T08:00:00Z',
  closed_at: null,
  providers_needed: 2,
  case_number: 1000,
  vacancy_number: 1,
  patient_id: 'patient-1',
  patient_first_name: 'Juan',
  patient_last_name: 'Perez',
  patient_zone: 'Palermo',
  patient_city: 'CABA',
  patient_neighborhood: null,
  patient_address_formatted: ENDERECO_REAL,
  patient_address_raw: null,
  dependency_level: null,
  contracted_service_id: null,
  locked_fields: [],
  required_sex: null,
  required_professions: [],
  age_range_min: null,
  age_range_max: null,
  worker_profile_sought: null,
  worker_attributes: null,
  required_experience: null,
  payment_day: null,
  closes_at: null,
  salary_text: null,
  schedule: null,
  meet_link_1: null,
  meet_link_2: null,
  meet_link_3: null,
};

function renderPage() {
  return render(
    <MemoryRouter>
      <DraftVacancyPage />
    </MemoryRouter>,
  );
}

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract,
  });
}

beforeEach(() => {
  vi.mocked(useVacancyDetail).mockReturnValue({
    vacancy: mockVacancy as any,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
});

describe('DraftVacancyPage — permissão de endereço respeita enforcement (D286, achado #1 do gate)', () => {
  it('enforcement OFF, sem patient_address:read → mostra o endereço que o GET devolveu (backend não redigiu)', () => {
    comEnforcement(['vacancy:read'], 'off');
    renderPage();
    expect(screen.getByTestId('address-value')).toHaveTextContent(ENDERECO_REAL);
  });

  it('enforcement ON, sem patient_address:read → "No visible para tu perfil" (não o valor do GET)', () => {
    comEnforcement(['vacancy:read'], 'on');
    renderPage();
    expect(screen.getByTestId('address-value')).toHaveTextContent('admin.draftVacancy.notVisibleForRole');
    expect(screen.queryByText(ENDERECO_REAL)).not.toBeInTheDocument();
  });

  it('enforcement ON, COM patient_address:read → mostra o endereço real', () => {
    comEnforcement(['vacancy:read', 'patient_address:read'], 'on');
    renderPage();
    expect(screen.getByTestId('address-value')).toHaveTextContent(ENDERECO_REAL);
  });
});
