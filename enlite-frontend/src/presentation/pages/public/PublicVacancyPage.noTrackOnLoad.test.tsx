/**
 * PublicVacancyPage.noTrackOnLoad.test.tsx — spec 043 (M1)
 *
 * Abrir a página pública da vaga NÃO registra o canal de aquisição: quem cria a postulação
 * (e a tag de canal) é só o clique em Postularse (`usePostularseAction`, coberto em
 * `hooks/__tests__/usePostularseAction.test.ts`). A página só guarda o `utm_source`
 * em sessionStorage para o clique usar.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import PublicVacancyPage from './PublicVacancyPage';
import { WorkerApiService } from '@infrastructure/http/WorkerApiService';
import type { PublicVacancyDetail } from '@domain/entities/Vacancy';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'vac-1' }),
  useLocation: () => ({ pathname: '/vacantes/vac-1', search: '?utm_source=instagram' }),
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@presentation/hooks/useAuth', () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

const vacancy: PublicVacancyDetail = {
  id: 'vac-1',
  case_number: 502,
  vacancy_number: 1,
  title: 'CASO 502-1',
  status: 'BUSQUEDA',
  is_disabled: false,
  required_professions: ['AT'],
  required_sex: null,
  age_range_min: null,
  age_range_max: null,
  worker_attributes: null,
  schedule: null,
  schedule_days_hours: null,
  salary_text: null,
  talentum_description: null,
  talentum_whatsapp_url: 'https://wa.me/5491112345678',
  patient_zone: 'Palermo, CABA',
  country: 'AR',
  created_at: '2026-09-01T00:00:00Z',
  service_type: ['AT'],
};

vi.mock('@infrastructure/http/PublicApiService', () => ({
  PublicApiService: { getVacancy: vi.fn(() => Promise.resolve(vacancy)) },
  VacancyNotFoundError: class VacancyNotFoundError extends Error {},
}));

vi.mock('@infrastructure/http/WorkerApiService', () => ({
  WorkerApiService: { trackAcquisitionChannel: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@presentation/hooks/usePostularseAction', () => ({
  usePostularseAction: () => ({
    state: 'idle',
    missingFields: null,
    postularse: vi.fn(),
    dismissModal: vi.fn(),
    confirmRegister: vi.fn(),
  }),
}));

describe('PublicVacancyPage — não rastreia canal ao carregar (spec 043, M1)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(WorkerApiService.trackAcquisitionChannel).mockClear();
  });

  it('autenticado + utm_source: guarda o UTM, mas NÃO chama trackAcquisitionChannel', async () => {
    render(<PublicVacancyPage />);
    expect(await screen.findByText('CASO 502-1')).toBeInTheDocument();
    // dá tempo a qualquer efeito pendente
    await new Promise((r) => setTimeout(r, 0));

    expect(WorkerApiService.trackAcquisitionChannel).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('enlite_utm_source')).toBe('instagram');
  });
});
