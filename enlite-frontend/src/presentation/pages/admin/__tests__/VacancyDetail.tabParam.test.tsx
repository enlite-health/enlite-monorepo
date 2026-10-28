/**
 * Aba do detalhe da vaga pela URL (spec 076, FR-12/17): `?tab=enquadre` abre a aba Enquadre; `tab` inválido cai em Recrutamento
 * (`encuadres`); sem a célula da aba, cai na 1ª visível; trocar de aba remove `event` (com `replace`, sem sujar o histórico).
 * Mesmo harness do `VacancyDetailPage.gate.test.tsx` (cards dublados), com roteador REAL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@hooks/admin/useVacancyDetail', () => ({ useVacancyDetail: vi.fn() }));
vi.mock('@presentation/components/ui/skeletons', () => ({ DetailSkeleton: () => <div /> }));
const { stub } = vi.hoisted(() => ({ stub: (name: string) => () => <div data-testid={name} /> }));
vi.mock('@presentation/components/features/admin/VacancyDetail/VacancyCaseCard', () => ({ VacancyCaseCard: stub('case') }));
vi.mock('@presentation/components/features/admin/VacancyDetail/VacancyPatientCard', () => ({ VacancyPatientCard: stub('patient') }));
vi.mock('@presentation/components/features/admin/VacancyDetail/VacancyProfessionCard', () => ({ VacancyProfessionCard: stub('profession') }));
vi.mock('@presentation/components/features/admin/VacancyDetail/Funnel/VacancyFunnelView', () => ({ VacancyFunnelView: stub('recrutamento') }));
vi.mock('@presentation/components/features/admin/VacancyDetail/VacancySocialLinksCard', () => ({ VacancySocialLinksCard: stub('links') }));
vi.mock('@presentation/components/features/admin/VacancyDetail/VacancyTalentumCard', () => ({ VacancyTalentumCard: stub('talentum') }));
vi.mock('@presentation/components/features/admin/VacancyDetail/VacancyPrescreeningConfig', () => ({ VacancyPrescreeningConfig: stub('prescreening') }));
vi.mock('@presentation/components/features/admin/VacancyDetail/VacancyScheduleEditModal', () => ({ VacancyScheduleEditModal: () => null }));
vi.mock('@presentation/components/features/admin/VacancyDetail/Enquadre/EnquadreTab', () => ({ EnquadreTab: stub('enquadre-aba') }));

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

const Probe = () => {
  const loc = useLocation();
  const nav = useNavigate();
  return (
    <>
      <span data-testid="url">{loc.pathname + loc.search}</span>
      <button data-testid="go-back" onClick={() => nav(-1)}>back</button>
    </>
  );
};
const mount = (search: string, history: string[] = []) =>
  render(
    <MemoryRouter initialEntries={[...history, `/admin/vacancies/v1${search}`]} initialIndex={history.length}>
      <Probe />
      <Routes><Route path="/admin/vacancies/:id" element={<VacancyDetailPage />} /></Routes>
    </MemoryRouter>,
  );
const comPerms = (permissions: string[], enforcement: AuthzContract['enforcement'] = 'on') =>
  useAdminAuthStore.setState({ authzStatus: 'ready', authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract });
const ativa = (): string | null => {
  const ids = ['encuadres', 'enquadre', 'talentum', 'links', 'notes'];
  return ids.find((id) => screen.queryByTestId(`vacancy-tab-${id}`)?.className.includes('bg-primary')) ?? null;
};
const TODAS = ['vacancy:read', 'funnel:read', 'enquadre_event:read', 'prescreening:read'];

beforeEach(() => {
  vi.mocked(useVacancyDetail).mockReturnValue({ vacancy: mockVacancy as never, isLoading: false, error: null, refetch: vi.fn() });
  comPerms(TODAS);
});
afterEach(() => { cleanup(); useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }); });

describe('detalhe da vaga: aba pela URL', () => {
  it('?tab=enquadre abre a aba Enquadre', () => {
    mount('?tab=enquadre');
    expect(ativa()).toBe('enquadre');
    expect(screen.getByTestId('enquadre-aba')).toBeInTheDocument();
  });

  it('sem tab, ou tab=xyz, abre Recrutamento (o padrão de antes)', () => {
    mount('');
    expect(ativa()).toBe('encuadres');
    cleanup();
    mount('?tab=xyz');
    expect(ativa()).toBe('encuadres');
    expect(screen.getByTestId('recrutamento')).toBeInTheDocument();
  });

  it('🔴 ?tab=enquadre SEM a célula da aba cai na 1ª aba visível (FR-17), sem mostrar o conteúdo do Enquadre', () => {
    comPerms(['vacancy:read', 'funnel:read']);
    mount('?tab=enquadre');
    expect(screen.queryByTestId('vacancy-tab-enquadre')).toBeNull();
    expect(ativa()).toBe('encuadres');
    expect(screen.queryByTestId('enquadre-aba')).toBeNull();
  });

  it('🔴 trocar de aba grava `tab`, REMOVE `event` e não suja o histórico (replace)', async () => {
    mount('?tab=enquadre&event=ev-9', ['/admin/enquadres?page=2']);
    await userEvent.click(screen.getByTestId('vacancy-tab-talentum'));
    expect(screen.getByTestId('url').textContent).toBe('/admin/vacancies/v1?tab=talentum');
    expect(ativa()).toBe('talentum');
    await userEvent.click(screen.getByTestId('go-back'));
    expect(screen.getByTestId('url').textContent).toBe('/admin/enquadres?page=2');
  });
});
