/**
 * PublicVacancyPage.deBaja.test.tsx — change baja-vacante-por-servico
 *
 * Requisito do dono do produto: serviço contratado dado de baixa desativa a(s) vaga(s)
 * ligada(s) — some do WordPress e do prestador, mas a página `/vacantes/:id` (link direto)
 * continua servindo, mostrando que está desativada, SEM oferecer candidatura.
 *
 * Molde: `PublicVacancyPage.error.test.tsx` (mocka getVacancy + hooks, não sobe a app inteira).
 * Diferença: aqui `getVacancy` RESOLVE com uma vaga `is_disabled: true` (status DE_BAJA), pra
 * provar o que a TELA faz com esse estado — não só que o backend o define.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import PublicVacancyPage from './PublicVacancyPage';
import type { PublicVacancyDetail } from '@domain/entities/Vacancy';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'vac-de-baja' }),
  useLocation: () => ({ pathname: '/vacantes/vac-de-baja', search: '' }),
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@presentation/hooks/useAuth', () => ({
  useAuth: () => ({ isAuthenticated: false }),
}));

const vacanciaDeBaja: PublicVacancyDetail = {
  id: 'vac-de-baja',
  case_number: 501,
  vacancy_number: 1,
  title: 'CASO 501-1',
  status: 'DE_BAJA',
  is_disabled: true,
  required_professions: ['AT'],
  required_sex: null,
  age_range_min: null,
  age_range_max: null,
  worker_attributes: null,
  schedule: null,
  schedule_days_hours: null,
  salary_text: null,
  talentum_description: null,
  // De propósito PREENCHIDO: prova que o botão some pelo `is_disabled`, não por falta de link.
  talentum_whatsapp_url: 'https://wa.me/5491112345678',
  patient_zone: 'Palermo, CABA',
  country: 'AR',
  created_at: '2026-09-01T00:00:00Z',
  service_type: ['AT'],
};

vi.mock('@infrastructure/http/PublicApiService', () => ({
  PublicApiService: { getVacancy: vi.fn(() => Promise.resolve(vacanciaDeBaja)) },
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

describe('PublicVacancyPage — vaga DE_BAJA (change baja-vacante-por-servico)', () => {
  it('NÃO renderiza o botão de Postularse, mesmo com talentum_whatsapp_url preenchido', async () => {
    render(<PublicVacancyPage />);
    expect(await screen.findByText('CASO 501-1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'publicVacancy.postularse' })).not.toBeInTheDocument();
  });

  it('mostra a mensagem de vaga desativada, não a de "ainda não disponível"', async () => {
    render(<PublicVacancyPage />);
    expect(await screen.findByText('publicVacancy.postularseDisabled')).toBeInTheDocument();
    expect(screen.queryByText('publicVacancy.postularseUnavailable')).not.toBeInTheDocument();
  });

  it('mostra o badge de status DE_BAJA (VacancyStatusBadge reusado, sem componente novo)', async () => {
    render(<PublicVacancyPage />);
    expect(await screen.findByText('admin.vacancyDetail.statusBadge.DE_BAJA')).toBeInTheDocument();
  });

  it('continua mostrando o resto da ficha (zona do paciente) — a página SERVE a vaga, não é um 404 disfarçado', async () => {
    render(<PublicVacancyPage />);
    expect(await screen.findAllByText('Palermo, CABA', { exact: false })).not.toHaveLength(0);
  });
});
