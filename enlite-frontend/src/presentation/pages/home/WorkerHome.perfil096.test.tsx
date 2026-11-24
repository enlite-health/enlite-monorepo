/**
 * WorkerHome × cadastro (096): incompleto (fonte: `missingFields` de /me) → UM bloco genérico, sem listar o que falta, NADA de mapa nem de lista (nem a pública) e a rota de vagas nem é habilitada; completo → mapa + lista;
 * carregando → nenhuma lista (sem "pisca"); falha da rota da home → cartão de erro com "Reintentar" (falha fechada: nem mapa, nem vagas, nem lista pública); conta inativa → a lista pública de sempre. O WorkerHome.test.tsx antigo segue sem edição.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { WorkerJobsByRadiusState } from '@presentation/hooks/useWorkerJobsByRadius';
import { WorkerHome } from './WorkerHome';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate }));
let missingFieldsMock: string[] | null = [];
vi.mock('@presentation/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'w1', name: 'Ana' } }) }));
// Funções ESTÁVEIS (o efeito da home depende delas; novas a cada render = laço de fetch).
const getProgressMock = vi.fn(async () => ({ id: 'w1', authUid: 'a', status: 'REGISTERED', missingFields: missingFieldsMock }));
const getAvailabilityMock = vi.fn(async () => []);
vi.mock('@presentation/hooks/useWorkerApi', () => ({ useWorkerApi: () => ({ getProgress: getProgressMock, getAvailability: getAvailabilityMock }) }));
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
const enabledCalls: boolean[] = [];
vi.mock('@presentation/hooks/useWorkerJobsByRadius', () => ({
  useWorkerJobsByRadius: (enabled: boolean, attempt = 0) => { enabledCalls.push(enabled); hookCalls.push(attempt); return hookState; },
}));

const OK: WorkerJobsByRadiusState = {
  status: 'ok',
  data: { items: [], center: { lat: -34.6, lng: -58.38 }, applied: { schedule: true, profession: true, sex: true }, missing: [] },
};

beforeEach(() => { hookState = { status: 'loading' }; hookCalls.length = 0; enabledCalls.length = 0; missingFieldsMock = []; mockNavigate.mockClear(); });

const lockedBlock = () => screen.findByTestId('complete-profile-notice');

describe('WorkerHome — cadastro para o mapa (096)', () => {
  it.each([[['address']], [['profession', 'availability']]] as const)('cadastro incompleto %j (missingFields) → bloco genérico; sem mapa, sem lista, sem banner antigo, rota de vagas nunca habilitada', async (missing) => {
    missingFieldsMock = [...missing];
    hookState = OK;
    render(<WorkerHome />);
    await lockedBlock();
    expect(screen.getByText('registrationLocked.title')).toBeInTheDocument();
    expect(screen.getByText('registrationLocked.text')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'registrationLocked.cta' })).toBeInTheDocument();
    expect(screen.queryByTestId('jobs-radius-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('points-map')).not.toBeInTheDocument();
    expect(screen.queryByTestId('jobs-embedded-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('complete-registration-banner')).not.toBeInTheDocument();
    expect(enabledCalls).not.toContain(true);
  });

  it('botão do bloco leva a /worker/profile (mesmo destino do "Completar" do banner)', async () => {
    missingFieldsMock = ['address'];
    render(<WorkerHome />);
    await lockedBlock();
    fireEvent.click(screen.getByTestId('complete-profile-cta'));
    expect(mockNavigate).toHaveBeenCalledWith('/worker/profile');
  });

  it('estado `incomplete` da rota → o MESMO bloco genérico, sem listar campos', async () => {
    hookState = { status: 'incomplete', missing: ['address', 'sex'] };
    render(<WorkerHome />);
    await lockedBlock();
    expect(screen.queryByTestId('profile-notice-item')).not.toBeInTheDocument();
    expect(screen.queryByText(/profileNotice/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('jobs-radius-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('jobs-embedded-section')).not.toBeInTheDocument();
  });

  it('completude não apurada (missingFields ausente) → fail-closed: bloco, sem mapa nem lista', async () => {
    missingFieldsMock = null;
    render(<WorkerHome />);
    await lockedBlock();
    expect(screen.queryByTestId('jobs-embedded-section')).not.toBeInTheDocument();
    expect(enabledCalls).not.toContain(true);
  });

  it('completo → mapa + lista, sem aviso, rota de vagas habilitada', async () => {
    hookState = OK;
    render(<WorkerHome />);
    expect(await screen.findByTestId('jobs-radius-section')).toBeInTheDocument();
    expect(screen.getByTestId('jobs-embedded-section')).toBeInTheDocument();
    expect(enabledCalls).toContain(true);
    expect(screen.queryByTestId('complete-profile-notice')).not.toBeInTheDocument();
  });

  it('carregando → esqueleto, sem lista (nada de lista pública que depois some)', async () => {
    render(<WorkerHome />);
    expect(screen.getByTestId('radius-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('complete-profile-notice')).not.toBeInTheDocument();
    await waitFor(() => expect(enabledCalls).toContain(true));
    expect(screen.queryByTestId('jobs-embedded-section')).not.toBeInTheDocument();
  });

  it('erro da rota → cartão de erro; sem mapa, sem vagas, sem lista pública, sem aviso de cadastro', async () => {
    hookState = { status: 'error' };
    render(<WorkerHome />);
    expect(await screen.findByTestId('home-load-error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'homeLoadError.retry' })).toBeInTheDocument();
    expect(screen.queryByTestId('jobs-embedded-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('jobs-radius-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('points-map')).not.toBeInTheDocument();
    expect(screen.queryByTestId('complete-profile-notice')).not.toBeInTheDocument();
  });

  it('"Reintentar" refaz a chamada (o hook recebe attempt+1)', async () => {
    hookState = { status: 'error' };
    render(<WorkerHome />);
    await screen.findByTestId('home-load-error');
    expect(Math.max(...hookCalls)).toBe(0);
    fireEvent.click(screen.getByTestId('home-load-error-retry'));
    expect(Math.max(...hookCalls)).toBe(1);
  });

  it('conta inativa → lista pública de sempre, sem cartão de erro', async () => {
    hookState = { status: 'inactive' };
    render(<WorkerHome />);
    expect(await screen.findByTestId('jobs-embedded-section')).toBeInTheDocument();
    expect(screen.queryByTestId('home-load-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('complete-profile-notice')).not.toBeInTheDocument();
  });
});
