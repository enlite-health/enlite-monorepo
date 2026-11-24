/**
 * JobsEmbeddedSection × raio (096, DD-6): `radiusScope` escopa a lista a feed ∩ ids do raio, por distância, com "a N,N km";
 * sem `radiusScope` nada muda (os testes antigos do arquivo ao lado seguem sem edição).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { JobsEmbeddedSection } from './JobsEmbeddedSection';
import type { PublicJobListing } from '@domain/entities/PublicJobListing';
import { useAuth } from '@presentation/hooks/useAuth';

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o && typeof o.defaultValue === 'string' ? o.defaultValue : o ? `${k}:${JSON.stringify(o)}` : k) }),
}));
const getPublicJobs = vi.fn();
vi.mock('@infrastructure/http/PublicApiService', () => ({ PublicApiService: { getPublicJobs: (...a: unknown[]) => getPublicJobs(...a) } }));
vi.mock('@presentation/hooks/useAuth');
vi.mock('@infrastructure/http/WorkerApiService');

const listing = (id: string, n: number): PublicJobListing => ({
  id, case_number: n, vacancy_number: n, title: `CASO ${n}`, status: 'SEARCHING', description: '', schedule_days_hours: null,
  worker_profile_sought: null, service: null, worker_type: ['AT'], worker_sex: 'F', state: 'CABA', city: 'Palermo', neighborhood: null,
  age_range_min: null, age_range_max: null, can_apply: false, detail_link: '',
} as unknown as PublicJobListing);

beforeEach(() => {
  vi.mocked(useAuth).mockReturnValue({ isAuthenticated: true, isLoading: false, user: null } as unknown as ReturnType<typeof useAuth>);
  getPublicJobs.mockResolvedValue([listing('a', 1), listing('b', 2), listing('c', 3)]);
});

describe('JobsEmbeddedSection com radiusScope', () => {
  it('lista = feed ∩ ids do raio, ordenada por distância, com a distância no card', async () => {
    render(<JobsEmbeddedSection radiusScope={{ c: 1.5, a: 7.25 }} />);
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(2));
    const cards = screen.getAllByTestId('job-card');
    expect(cards[0]).toHaveTextContent('-3'); // c (1,5 km) primeiro
    expect(cards[1]).toHaveTextContent('-1');
    expect(screen.getAllByTestId('job-distance').map((e) => e.textContent)).toEqual([
      'jobsRadius.distance:{"km":"1,5"}', 'jobsRadius.distance:{"km":"7,3"}',
    ]);
  });

  it('sem radiusScope: o feed inteiro, sem distância (comportamento de sempre)', async () => {
    render(<JobsEmbeddedSection />);
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(3));
    expect(screen.queryByTestId('job-distance')).not.toBeInTheDocument();
  });

  it('fallback "mais próximas": cabeçalho explicativo + vagas do escopo por distância; filtros seguem valendo', async () => {
    render(<JobsEmbeddedSection radiusScope={{ b: 197.2, a: 205 }} nearestFallback />);
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(2));
    expect(screen.getByTestId('jobs-nearest-header')).toHaveTextContent('jobs.nearestHeader');
    expect(screen.getAllByTestId('job-card')[0]).toHaveTextContent('-2'); // b (a mais próxima) primeiro
    fireEvent.change(screen.getByPlaceholderText('jobs.searchPlaceholder'), { target: { value: 'CASO 1' } });
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(1));
  });

  it('sem fallback (com ou sem escopo): nenhum cabeçalho de "mais próximas"', async () => {
    render(<JobsEmbeddedSection radiusScope={{ c: 1.5 }} />);
    await waitFor(() => expect(screen.getAllByTestId('job-card')).toHaveLength(1));
    expect(screen.queryByTestId('jobs-nearest-header')).not.toBeInTheDocument();
  });

  it('escopo vazio (0 vagas no raio) → lista vazia, não o feed inteiro', async () => {
    render(<JobsEmbeddedSection radiusScope={{}} />);
    await waitFor(() => expect(screen.getByText('jobs.noResults')).toBeInTheDocument());
    expect(screen.queryAllByTestId('job-card')).toHaveLength(0);
  });
});
