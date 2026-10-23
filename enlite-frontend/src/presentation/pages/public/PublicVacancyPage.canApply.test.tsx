/**
 * PublicVacancyPage.canApply.test.tsx — spec 067 FR-15
 *
 * O link da Talentum não sai mais da rota pública: a página decide "vaga postulável" por `can_apply` (booleano) e passa esse
 * booleano ao hook. Molde: `PublicVacancyPage.deBaja.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import PublicVacancyPage from './PublicVacancyPage';
import type { PublicVacancyDetail } from '@domain/entities/Vacancy';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'vac-1' }),
  useLocation: () => ({ pathname: '/vacantes/vac-1', search: '' }),
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@presentation/hooks/useAuth', () => ({
  useAuth: () => ({ isAuthenticated: false }),
}));

const base: PublicVacancyDetail = {
  id: 'vac-1',
  case_number: 502,
  vacancy_number: 1,
  title: 'CASO 502-1',
  status: 'SEARCHING',
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
  can_apply: true,
  patient_zone: 'Palermo, CABA',
  country: 'AR',
  created_at: '2026-09-01T00:00:00Z',
  service_type: ['AT'],
};

let current: PublicVacancyDetail = base;
const hookArgs: unknown[][] = [];

vi.mock('@infrastructure/http/PublicApiService', () => ({
  PublicApiService: { getVacancy: vi.fn(() => Promise.resolve(current)) },
  VacancyNotFoundError: class VacancyNotFoundError extends Error {},
}));

vi.mock('@presentation/hooks/usePostularseAction', () => ({
  usePostularseAction: (...args: unknown[]) => {
    hookArgs.push(args);
    return { state: 'idle', missingFields: null, postularse: vi.fn(), dismissModal: vi.fn(), confirmRegister: vi.fn() };
  },
}));

beforeEach(() => {
  hookArgs.length = 0;
});

describe('PublicVacancyPage — postulável por can_apply (spec 067 FR-15)', () => {
  it('can_apply true: botão Postularse habilitado, sem a mensagem de indisponível, e o hook recebe true', async () => {
    current = { ...base, can_apply: true };
    render(<PublicVacancyPage />);
    const button = await screen.findByRole('button', { name: 'publicVacancy.postularse' });
    expect(button).not.toBeDisabled();
    expect(screen.queryByText('publicVacancy.postularseUnavailable')).not.toBeInTheDocument();
    expect(hookArgs[hookArgs.length - 1][0]).toBe(true);
  });

  it('can_apply false: botão Postularse desabilitado, mensagem de indisponível, e o hook recebe false', async () => {
    current = { ...base, can_apply: false };
    render(<PublicVacancyPage />);
    const button = await screen.findByRole('button', { name: 'publicVacancy.postularse' });
    expect(button).toBeDisabled();
    expect(screen.getByText('publicVacancy.postularseUnavailable')).toBeInTheDocument();
    expect(hookArgs[hookArgs.length - 1][0]).toBe(false);
  });
});
