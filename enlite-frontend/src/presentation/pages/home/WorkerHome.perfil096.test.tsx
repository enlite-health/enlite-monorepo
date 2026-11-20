/**
 * WorkerHome × cadastro (096, decisão 19/11): incompleto → aviso, NADA de mapa nem de lista (nem a pública); completo → mapa + lista;
 * carregando → nenhuma lista (sem "pisca"); falha da rota da home → cartão de erro com "Reintentar" (falha fechada: nem mapa, nem vagas, nem lista pública); conta inativa → a lista pública de sempre. O WorkerHome.test.tsx antigo segue sem edição.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { WorkerJobsByRadiusState } from '@presentation/hooks/useWorkerJobsByRadius';
import { WorkerHome } from './WorkerHome';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@presentation/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'w1', name: 'Ana' } }) }));
vi.mock('@presentation/hooks/useWorkerApi', () => ({
  useWorkerApi: () => ({ getProgress: vi.fn(async () => ({ id: 'w1', authUid: 'a', status: 'REGISTERED', missingFields: [] })), getAvailability: vi.fn(async () => []) }),
}));
vi.mock('@infrastructure/analytics/clarity', () => ({ identifyClarity: vi.fn() }));
vi.mock('@presentation/config/workerNavigation', () => ({ useWorkerNavItems: () => [] }));
vi.mock('@presentation/stores/workerRegistrationStore', () => ({ useWorkerRegistrationStore: () => null }));
vi.mock('@presentation/components/templates/DashboardLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@presentation/components/templates/DashboardLayout/TopNavbar', () => ({ TopNavbar: () => <div /> }));
vi.mock('@presentation/components/organisms/PendingTasksCard', () => ({ PendingTasksCard: () => null }));
vi.mock('@presentation/components/features/worker/JobsEmbeddedSection', () => ({ JobsEmbeddedSection: () => <div data-testid="jobs-embedded-section" /> }));
vi.mock('@presentation/components/molecules/PointsMap/PointsMap', () => ({ PointsMap: () => <div data-testid="points-map" /> }));

let hookState: WorkerJobsByRadiusState = { status: 'loading' };
const hookCalls: number[] = [];
vi.mock('@presentation/hooks/useWorkerJobsByRadius', () => ({
  useWorkerJobsByRadius: (_enabled: boolean, attempt = 0) => { hookCalls.push(attempt); return hookState; },
}));

const OK: WorkerJobsByRadiusState = {
  status: 'ok',
  data: { items: [], center: { lat: -34.6, lng: -58.38 }, applied: { schedule: true, profession: true, sex: true }, missing: [] },
};

beforeEach(() => { hookState = { status: 'loading' }; hookCalls.length = 0; });

describe('WorkerHome — cadastro para o mapa (096)', () => {
  it.each([
    [['address']], [['profession']], [['sex']], [['availability']], [['address', 'profession']],
  ] as const)('incompleto %j → aviso com esses itens; sem mapa e sem lista', (missing) => {
    hookState = { status: 'incomplete', missing: [...missing] };
    render(<WorkerHome />);
    expect(screen.getByTestId('complete-profile-notice')).toBeInTheDocument();
    expect(screen.getAllByTestId('profile-notice-item').map((e) => e.getAttribute('data-item'))).toEqual([...missing]);
    expect(screen.queryByTestId('jobs-radius-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('points-map')).not.toBeInTheDocument();
    expect(screen.queryByTestId('jobs-embedded-section')).not.toBeInTheDocument();
  });

  it('completo → mapa + lista, sem aviso', () => {
    hookState = OK;
    render(<WorkerHome />);
    expect(screen.getByTestId('jobs-radius-section')).toBeInTheDocument();
    expect(screen.getByTestId('jobs-embedded-section')).toBeInTheDocument();
    expect(screen.queryByTestId('complete-profile-notice')).not.toBeInTheDocument();
  });

  it('carregando → esqueleto, sem lista (nada de lista pública que depois some)', () => {
    render(<WorkerHome />);
    expect(screen.getByTestId('radius-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('jobs-embedded-section')).not.toBeInTheDocument();
  });

  it('erro da rota → cartão de erro; sem mapa, sem vagas, sem lista pública, sem aviso de cadastro', () => {
    hookState = { status: 'error' };
    render(<WorkerHome />);
    expect(screen.getByTestId('home-load-error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'homeLoadError.retry' })).toBeInTheDocument();
    expect(screen.queryByTestId('jobs-embedded-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('jobs-radius-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('points-map')).not.toBeInTheDocument();
    expect(screen.queryByTestId('complete-profile-notice')).not.toBeInTheDocument();
  });

  it('"Reintentar" refaz a chamada (o hook recebe attempt+1)', () => {
    hookState = { status: 'error' };
    render(<WorkerHome />);
    expect(Math.max(...hookCalls)).toBe(0);
    fireEvent.click(screen.getByTestId('home-load-error-retry'));
    expect(Math.max(...hookCalls)).toBe(1);
  });

  it('conta inativa → lista pública de sempre, sem cartão de erro', () => {
    hookState = { status: 'inactive' };
    render(<WorkerHome />);
    expect(screen.getByTestId('jobs-embedded-section')).toBeInTheDocument();
    expect(screen.queryByTestId('home-load-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('complete-profile-notice')).not.toBeInTheDocument();
  });
});
