/**
 * DraftVacancyPage.providers.test.tsx — gate fecho da Fase 2 (25/09, rodada 3).
 *
 * `Number(vacancy.providers_needed ?? 0)` mascarava dois casos: `null` virava "0 profesionales"
 * (zero não é "não sei quantos", é uma resposta — igual a `zoneCity`/`schedule`, que já omitem o
 * segmento em vez de inventar um valor) e string inválida virava "NaN profesionales". i18n REAL
 * (não mockado) para provar o TEXTO que chega na tela, não só a chave — molde:
 * `sex-both-i18n.test.tsx`.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'draft-vacancy-id' }),
    useNavigate: () => mockNavigate,
  };
});

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

vi.mock('@presentation/components/features/admin/VacancyDetail/DraftVacancyKnownCard', () => ({
  DraftVacancyKnownCard: () => <div data-testid="known-card">KnownCard</div>,
}));

vi.mock('@presentation/components/features/admin/VacancyDetail/DraftVacancyTodoCard', () => ({
  DraftVacancyTodoCard: () => <div data-testid="todo-card">TodoCard</div>,
}));

import { useVacancyDetail } from '@hooks/admin/useVacancyDetail';
import DraftVacancyPage from '../DraftVacancyPage';

const baseVacancy = {
  id: 'draft-vacancy-id',
  is_draft: true,
  status: 'SEARCHING',
  country: 'AR',
  created_at: '2026-09-25T00:00:00Z',
  updated_at: '2026-09-25T08:00:00Z',
  closed_at: null,
  case_number: 1000,
  vacancy_number: 1,
  patient_id: 'patient-1',
  patient_first_name: 'Juan',
  patient_last_name: 'Perez',
  patient_zone: null,
  patient_city: null,
  patient_neighborhood: null,
  patient_address_formatted: null,
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

beforeEach(() => {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u',
      tenantId: 't',
      status: 'ACTIVE',
      permissions: ['vacancy:read'],
      countries: [],
      groups: [],
      features: {},
      enforcement: 'off',
    } as AuthzContract,
  });
});

describe('DraftVacancyPage — subtítulo: providers_needed null/inválido não vira "0"/"NaN" (gate fecho 25/09)', () => {
  it('providers_needed null → subtítulo NÃO menciona "profesionales"', () => {
    vi.mocked(useVacancyDetail).mockReturnValue({
      vacancy: { ...baseVacancy, providers_needed: null } as any,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    renderPage();
    expect(screen.queryByText(/profesional/)).not.toBeInTheDocument();
  });

  it('providers_needed = "2" (string, como o GET às vezes devolve) → "2 profesionales"', () => {
    vi.mocked(useVacancyDetail).mockReturnValue({
      vacancy: { ...baseVacancy, providers_needed: '2' } as any,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    renderPage();
    expect(screen.getByText(/2 profesionales/)).toBeInTheDocument();
  });

  it('providers_needed = "abc" (string inválida) → subtítulo NÃO menciona "profesionales" (nunca "NaN")', () => {
    vi.mocked(useVacancyDetail).mockReturnValue({
      vacancy: { ...baseVacancy, providers_needed: 'abc' } as any,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    renderPage();
    expect(screen.queryByText(/profesional/)).not.toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });
});
