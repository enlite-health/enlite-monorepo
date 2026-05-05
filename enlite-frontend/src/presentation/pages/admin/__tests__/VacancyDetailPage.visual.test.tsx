/**
 * VacancyDetailPage.visual.test.tsx
 *
 * Testes visuais/estruturais que GARANTEM:
 * - Cards fixos (CaseCard, PatientCard, ProfessionCard) sempre visíveis
 * - Tabs renderizam e alternam conteúdo corretamente
 * - Cada aba exibe apenas seus componentes
 * - Loading e error states funcionam
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

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

vi.mock('@presentation/components/features/admin/VacancyFormModal', () => ({
  VacancyFormModal: () => null,
}));

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
  patient_diagnosis: 'TEA',
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

// ── GARANTIA 1: Cards fixos sempre visíveis ──────────────────────────────────

describe('VacancyDetailPage — fixed section always visible', () => {
  it('CRITICAL: case card is always visible', () => {
    renderPage();
    expect(screen.getByTestId('vacancy-case-card')).toBeInTheDocument();
  });

  it('CRITICAL: patient card is always visible', () => {
    renderPage();
    expect(screen.getByTestId('vacancy-patient-card')).toBeInTheDocument();
  });

  it('CRITICAL: profession card is always visible', () => {
    renderPage();
    expect(screen.getByTestId('vacancy-profession-card')).toBeInTheDocument();
  });

  it('CRITICAL: fixed cards remain visible after switching to talentum tab', async () => {
    renderPage();
    await userEvent.click(screen.getByText('admin.vacancyDetail.tabs.talentum'));

    expect(screen.getByTestId('vacancy-case-card')).toBeInTheDocument();
    expect(screen.getByTestId('vacancy-patient-card')).toBeInTheDocument();
    expect(screen.getByTestId('vacancy-profession-card')).toBeInTheDocument();
  });

  it('CRITICAL: fixed cards remain visible after switching to links tab', async () => {
    renderPage();
    await userEvent.click(screen.getByText('admin.vacancyDetail.tabs.links'));

    expect(screen.getByTestId('vacancy-case-card')).toBeInTheDocument();
    expect(screen.getByTestId('vacancy-patient-card')).toBeInTheDocument();
    expect(screen.getByTestId('vacancy-profession-card')).toBeInTheDocument();
  });
});

// ── GARANTIA 2: Tabs renderizam ──────────────────────────────────────────────

describe('VacancyDetailPage — tabs component', () => {
  it('CRITICAL: all 3 tab buttons are rendered', () => {
    renderPage();
    expect(
      screen.getByText('admin.vacancyDetail.tabs.encuadres'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('admin.vacancyDetail.tabs.talentum'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('admin.vacancyDetail.tabs.links'),
    ).toBeInTheDocument();
  });

  it('default active tab is encuadres (has bg-primary)', () => {
    renderPage();
    const encuadresTab = screen.getByText('admin.vacancyDetail.tabs.encuadres');
    expect(encuadresTab.className).toContain('bg-primary');
  });
});

// ── GARANTIA 3: Aba Encuadres (default) ──────────────────────────────────────

describe('VacancyDetailPage — tab content encuadres (default)', () => {
  it('CRITICAL: encuadres card is visible on default tab', () => {
    renderPage();
    expect(screen.getByTestId('vacancy-encuadres-card')).toBeInTheDocument();
  });

  it('meet links card is NOT visible on encuadres tab', () => {
    renderPage();
    expect(
      screen.queryByTestId('vacancy-meet-links-card'),
    ).not.toBeInTheDocument();
  });

  it('talentum card is NOT visible on encuadres tab', () => {
    renderPage();
    expect(
      screen.queryByTestId('vacancy-talentum-card'),
    ).not.toBeInTheDocument();
  });

  it('prescreening config is NOT visible on encuadres tab', () => {
    renderPage();
    expect(
      screen.queryByTestId('vacancy-prescreening-config'),
    ).not.toBeInTheDocument();
  });
});

// ── GARANTIA 4: Aba Talentum ─────────────────────────────────────────────────

describe('VacancyDetailPage — tab content talentum', () => {
  it('CRITICAL: prescreening config is visible after clicking talentum tab', async () => {
    renderPage();
    await userEvent.click(
      screen.getByText('admin.vacancyDetail.tabs.talentum'),
    );
    expect(
      screen.getByTestId('vacancy-prescreening-config'),
    ).toBeInTheDocument();
  });

  it('CRITICAL: talentum card is visible after clicking talentum tab', async () => {
    renderPage();
    await userEvent.click(
      screen.getByText('admin.vacancyDetail.tabs.talentum'),
    );
    expect(screen.getByTestId('vacancy-talentum-card')).toBeInTheDocument();
  });

  it('CRITICAL: publications section is visible after clicking talentum tab', async () => {
    renderPage();
    await userEvent.click(
      screen.getByText('admin.vacancyDetail.tabs.talentum'),
    );
    expect(
      screen.getByText('admin.vacancyDetail.publications.title'),
    ).toBeInTheDocument();
  });

  it('encuadres card is NOT visible on talentum tab', async () => {
    renderPage();
    await userEvent.click(
      screen.getByText('admin.vacancyDetail.tabs.talentum'),
    );
    expect(
      screen.queryByTestId('vacancy-encuadres-card'),
    ).not.toBeInTheDocument();
  });

  it('meet links card is NOT visible on talentum tab', async () => {
    renderPage();
    await userEvent.click(
      screen.getByText('admin.vacancyDetail.tabs.talentum'),
    );
    expect(
      screen.queryByTestId('vacancy-meet-links-card'),
    ).not.toBeInTheDocument();
  });
});

// ── GARANTIA 5: Aba Links ────────────────────────────────────────────────────

describe('VacancyDetailPage — tab content links', () => {
  it('CRITICAL: meet links card is visible after clicking links tab', async () => {
    renderPage();
    await userEvent.click(screen.getByText('admin.vacancyDetail.tabs.links'));
    expect(screen.getByTestId('vacancy-meet-links-card')).toBeInTheDocument();
  });

  it('encuadres card is NOT visible on links tab', async () => {
    renderPage();
    await userEvent.click(screen.getByText('admin.vacancyDetail.tabs.links'));
    expect(
      screen.queryByTestId('vacancy-encuadres-card'),
    ).not.toBeInTheDocument();
  });

  it('talentum card is NOT visible on links tab', async () => {
    renderPage();
    await userEvent.click(screen.getByText('admin.vacancyDetail.tabs.links'));
    expect(
      screen.queryByTestId('vacancy-talentum-card'),
    ).not.toBeInTheDocument();
  });
});

// ── GARANTIA 6: Navegação entre abas ─────────────────────────────────────────

describe('VacancyDetailPage — tab navigation round-trip', () => {
  it('switching tabs back to encuadres restores encuadres content', async () => {
    renderPage();

    await userEvent.click(screen.getByText('admin.vacancyDetail.tabs.links'));
    expect(screen.getByTestId('vacancy-meet-links-card')).toBeInTheDocument();
    expect(
      screen.queryByTestId('vacancy-encuadres-card'),
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByText('admin.vacancyDetail.tabs.encuadres'),
    );
    expect(screen.getByTestId('vacancy-encuadres-card')).toBeInTheDocument();
    expect(
      screen.queryByTestId('vacancy-meet-links-card'),
    ).not.toBeInTheDocument();
  });
});

// ── GARANTIA 7: Loading state ────────────────────────────────────────────────

describe('VacancyDetailPage — loading state', () => {
  it('renders skeleton when isLoading is true', () => {
    vi.mocked(useVacancyDetail).mockReturnValue({
      vacancy: null as any,
      isLoading: true,
      error: null,
      refetch: mockRefetch,
    });
    renderPage();
    expect(screen.getByTestId('detail-skeleton')).toBeInTheDocument();
  });

  it('no cards are rendered during loading', () => {
    vi.mocked(useVacancyDetail).mockReturnValue({
      vacancy: null as any,
      isLoading: true,
      error: null,
      refetch: mockRefetch,
    });
    renderPage();
    expect(
      screen.queryByTestId('vacancy-case-card'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('vacancy-patient-card'),
    ).not.toBeInTheDocument();
  });
});

// ── GARANTIA 8: Error state ──────────────────────────────────────────────────

describe('VacancyDetailPage — error state', () => {
  it('shows error message when error is present', () => {
    vi.mocked(useVacancyDetail).mockReturnValue({
      vacancy: null as any,
      isLoading: false,
      error: 'Erro ao carregar',
      refetch: mockRefetch,
    });
    renderPage();
    expect(screen.getByText('Erro ao carregar')).toBeInTheDocument();
  });

  it('no cards are rendered in error state', () => {
    vi.mocked(useVacancyDetail).mockReturnValue({
      vacancy: null as any,
      isLoading: false,
      error: 'Erro ao carregar',
      refetch: mockRefetch,
    });
    renderPage();
    expect(
      screen.queryByTestId('vacancy-case-card'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('vacancy-encuadres-card'),
    ).not.toBeInTheDocument();
  });
});
