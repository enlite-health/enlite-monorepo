/**
 * VacancyDetailPage.gate.test.tsx — D286 fase 2: containers e abas da vaga por célula.
 *  · card Paciente = `patient_identity` (célula do OUTRO titular; a rota já projetou o nome)
 *  · aba Encuadres = funnel/match/messaging · Talentum = prescreening/talentum · Links = vacancy
 *  · aba sem container legível SOME; a ativa cai na primeira visível
 * Mesmo harness do `.visual.test.tsx` (cards e abas dublados).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockRefetch = vi.fn();
const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'test-vacancy-id' }),
    useNavigate: () => mockNavigate,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@hooks/admin/useVacancyDetail', () => ({
  useVacancyDetail: vi.fn(),
}));

vi.mock('@presentation/components/ui/skeletons', () => ({
  DetailSkeleton: () => <div data-testid="detail-skeleton">Loading...</div>,
}));

vi.mock(
  '@presentation/components/features/admin/VacancyDetail/VacancyCaseCard',
  () => ({
    VacancyCaseCard: () => <div data-testid="vacancy-case-card">CaseCard</div>,
  }),
);

vi.mock(
  '@presentation/components/features/admin/VacancyDetail/VacancyPatientCard',
  () => ({
    VacancyPatientCard: () => (
      <div data-testid="vacancy-patient-card">PatientCard</div>
    ),
  }),
);

vi.mock(
  '@presentation/components/features/admin/VacancyDetail/VacancyProfessionCard',
  () => ({
    VacancyProfessionCard: () => (
      <div data-testid="vacancy-profession-card">ProfessionCard</div>
    ),
  }),
);

vi.mock(
  '@presentation/components/features/admin/VacancyDetail/VacancyMeetLinksRow',
  () => ({
    VacancyMeetLinksRow: () => null,
  }),
);

vi.mock(
  '@presentation/components/features/admin/VacancyDetail/Funnel/VacancyFunnelView',
  () => ({
    VacancyFunnelView: () => (
      <div data-testid="vacancy-encuadres-card">FunnelView</div>
    ),
  }),
);

vi.mock(
  '@presentation/components/features/admin/VacancyDetail/VacancyMeetLinksCard',
  () => ({
    VacancyMeetLinksCard: () => (
      <div data-testid="vacancy-meet-links-card">MeetLinksCard</div>
    ),
  }),
);

vi.mock(
  '@presentation/components/features/admin/VacancyDetail/VacancyPrescreeningConfig',
  () => ({
    VacancyPrescreeningConfig: () => (
      <div data-testid="vacancy-prescreening-config">PrescreeningConfig</div>
    ),
  }),
);

vi.mock(
  '@presentation/components/features/admin/VacancyDetail/VacancyTalentumCard',
  () => ({
    VacancyTalentumCard: () => (
      <div data-testid="vacancy-talentum-card">TalentumCard</div>
    ),
  }),
);

vi.mock(
  '@presentation/components/features/admin/VacancyDetail/VacancyScheduleEditModal',
  () => ({
    VacancyScheduleEditModal: () => null,
  }),
);

import { useVacancyDetail } from '@hooks/admin/useVacancyDetail';
import VacancyDetailPage from '../VacancyDetailPage';

const mockVacancy = {
  id: 'test-vacancy-id',
  status: 'BUSQUEDA',
  country: 'AR',
  created_at: '2026-04-04T00:00:00Z',
  closed_at: null,
  providers_needed: 1,
  case_number: 748,
  vacancy_number: 1,
  patient_first_name: 'Juan',
  patient_last_name: 'Perez',
  patient_zone: 'Palermo',
  patient_city: null,
  patient_neighborhood: null,
  insurance_verified: true,
  dependency_level: null,
  required_sex: 'M',
  required_professions: ['AT'],
  age_range_min: null,
  age_range_max: null,
  worker_attributes: null,
  service_type: null,
  city: null,
  schedule_days_hours: null,
  schedule: null,
  payment_term_days: null,
  net_hourly_rate: null,
  weekly_hours: null,
  meet_link_1: null,
  meet_datetime_1: null,
  meet_link_2: null,
  meet_datetime_2: null,
  meet_link_3: null,
  meet_datetime_3: null,
  encuadres: [],
  talentum_project_id: null,
  talentum_whatsapp_url: null,
  talentum_slug: null,
  talentum_published_at: null,
  talentum_description: null,
  social_short_links: null,
  publications: [],
  title: null,
};

function renderPage() {
  return render(
    <MemoryRouter>
      <VacancyDetailPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(useVacancyDetail).mockReturnValue({
    vacancy: mockVacancy as any,
    isLoading: false,
    error: null,
    refetch: mockRefetch,
  });
});


function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract,
  });
}
const aba = (nome: string) => screen.queryByRole('button', { name: new RegExp(`admin.vacancyDetail.tabs.${nome}`) });

describe('VacancyDetailPage — containers por célula (D286 fase 2)', () => {
  it('só vacancy:read: caso e perfil ficam; card Paciente SOME; só a aba Links existe e é a ativa', () => {
    comEnforcement(['vacancy:read'], 'on');
    renderPage();
    expect(screen.getByTestId('vacancy-case-card')).toBeInTheDocument();
    expect(screen.getByTestId('vacancy-profession-card')).toBeInTheDocument();
    expect(screen.queryByTestId('vacancy-patient-card')).not.toBeInTheDocument();
    expect(aba('encuadres')).not.toBeInTheDocument();
    expect(aba('talentum')).not.toBeInTheDocument();
    expect(aba('links')).toBeInTheDocument();
    expect(aba('links')?.className).toContain('bg-primary');
  });

  it('patient_identity:read devolve o card Paciente', () => {
    comEnforcement(['vacancy:read', 'patient_identity:read'], 'on');
    renderPage();
    expect(screen.getByTestId('vacancy-patient-card')).toBeInTheDocument();
  });

  it('funnel:read abre a aba Encuadres; prescreening:read sozinho abre Talentum com só a pré-seleção', async () => {
    comEnforcement(['vacancy:read', 'funnel:read', 'prescreening:read'], 'on');
    renderPage();
    expect(aba('encuadres')).toBeInTheDocument();
    expect(aba('talentum')).toBeInTheDocument();
    await userEvent.click(aba('talentum')!);
    expect(screen.getByTestId('vacancy-prescreening-config')).toBeInTheDocument();
    expect(screen.queryByTestId('vacancy-talentum-card')).not.toBeInTheDocument();
  });

  it('enforcement=off: tudo como antes (3 abas, card Paciente)', () => {
    comEnforcement([], 'off');
    renderPage();
    expect(screen.getByTestId('vacancy-patient-card')).toBeInTheDocument();
    expect(aba('encuadres')).toBeInTheDocument();
    expect(aba('talentum')).toBeInTheDocument();
    expect(aba('links')).toBeInTheDocument();
  });
});
