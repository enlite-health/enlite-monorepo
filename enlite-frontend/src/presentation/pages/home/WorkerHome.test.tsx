/**
 * WorkerHome.test.tsx
 *
 * Fase 2 de postulacao-documento-pendente (DD1/DD2): a home PAROU de buscar
 * `DocumentApiService.getDocuments()` e de calcular completude local
 * (`areAllRequiredDocsComplete`) — `isFullyRegistered`/`hasPendingTasks`
 * vêm SÓ de `workerData.missingFields` (Fase 1, servidor). O card antigo
 * (`ProfileCompletionCard`) foi trocado por `PendingTasksCard`, que recebe
 * `missingFields`/`profession` crus e decide sozinho o que mostrar.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { WorkerHome } from './WorkerHome';
import type { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';
import { makeWorkerProgress } from '../../../test/workerProgressFixtures';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let mockUser: { id: string; name: string } | null = { id: 'worker-1', name: 'Ana Prestadora' };
vi.mock('@presentation/hooks/useAuth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

const mockGetProgress = vi.fn();
const mockGetAvailability = vi.fn();
vi.mock('@presentation/hooks/useWorkerApi', () => ({
  useWorkerApi: () => ({ getProgress: mockGetProgress, getAvailability: mockGetAvailability }),
}));

const mockIdentifyClarity = vi.fn();
vi.mock('@infrastructure/analytics/clarity', () => ({
  identifyClarity: (...args: unknown[]) => mockIdentifyClarity(...args),
}));

vi.mock('@presentation/config/workerNavigation', () => ({
  useWorkerNavItems: () => [],
}));

let mockProfilePhoto: string | null = null;
vi.mock('@presentation/stores/workerRegistrationStore', () => ({
  useWorkerRegistrationStore: () => mockProfilePhoto,
}));

vi.mock('@presentation/components/templates/DashboardLayout', () => ({
  AppLayout: ({ children, userName }: { children: React.ReactNode; userName: string }) => (
    <div data-testid="app-layout" data-username={userName}>{children}</div>
  ),
}));

vi.mock('@presentation/components/templates/DashboardLayout/TopNavbar', () => ({
  TopNavbar: ({ userName }: { userName: string }) => <div data-testid="top-navbar">{userName}</div>,
}));

vi.mock('@presentation/components/organisms/PendingTasksCard', () => ({
  PendingTasksCard: ({
    missingFields,
    profession,
    country,
  }: {
    missingFields: string[];
    profession?: string | null;
    country?: string | null;
  }) => (
    <div
      data-testid="pending-tasks-card"
      data-missing-fields={JSON.stringify(missingFields)}
      data-profession={profession ?? ''}
      data-country={country ?? ''}
    />
  ),
}));

vi.mock('@presentation/components/features/worker/JobsEmbeddedSection', () => ({
  JobsEmbeddedSection: ({
    isRegistrationComplete,
    missingFields,
  }: {
    isRegistrationComplete: boolean;
    missingFields: string[] | null;
  }) => (
    <div
      data-testid="jobs-embedded-section"
      data-registration-complete={String(isRegistrationComplete)}
      data-missing-fields={JSON.stringify(missingFields)}
    />
  ),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeWorker(overrides: Partial<WorkerProgressResponse> = {}): WorkerProgressResponse {
  return makeWorkerProgress({
    id: 'worker-1',
    authUid: 'auth-1',
    email: 'ana@test.com',
    firstName: 'Ana',
    lastName: 'Prestadora',
    sex: 'female',
    gender: 'female',
    profession: 'CUIDADOR',
    availability: undefined,
    status: 'REGISTERED',
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUser = { id: 'worker-1', name: 'Ana Prestadora' };
  mockProfilePhoto = null;
});

// ── Sem usuário ───────────────────────────────────────────────────────────────

describe('WorkerHome — sem user.id', () => {
  it('não dispara fetch nenhum; JobsEmbeddedSection recebe isRegistrationComplete=false, missingFields=null', () => {
    mockUser = null;
    render(<WorkerHome />);

    expect(mockGetProgress).not.toHaveBeenCalled();
    expect(mockGetAvailability).not.toHaveBeenCalled();

    const jobs = screen.getByTestId('jobs-embedded-section');
    expect(jobs).toHaveAttribute('data-registration-complete', 'false');
    expect(jobs).toHaveAttribute('data-missing-fields', 'null');
    expect(screen.queryByTestId('pending-tasks-card')).not.toBeInTheDocument();
  });
});

// ── Fetch com sucesso — cadastro completo ────────────────────────────────────

describe('WorkerHome — cadastro completo (missingFields: [] do servidor)', () => {
  it('worker completo → PendingTasksCard NÃO aparece, Clarity chamado, JobsEmbeddedSection completo', async () => {
    const worker = makeWorker({ missingFields: [] });
    mockGetProgress.mockResolvedValue(worker);
    mockGetAvailability.mockResolvedValue([{ day: 'monday', start: '09:00', end: '17:00' }]);

    render(<WorkerHome />);

    await waitFor(() => {
      expect(screen.getByTestId('jobs-embedded-section')).toHaveAttribute('data-registration-complete', 'true');
    });

    expect(screen.queryByTestId('pending-tasks-card')).not.toBeInTheDocument();
    expect(mockIdentifyClarity).toHaveBeenCalledWith('auth-1', { workerId: 'worker-1', workerStatus: 'REGISTERED' });
    expect(screen.getByTestId('jobs-embedded-section')).toHaveAttribute('data-missing-fields', '[]');
  });

  it('data.status ausente → identifyClarity recebe workerStatus vazio (fallback ??)', async () => {
    const worker = makeWorker({ missingFields: [], status: undefined });
    mockGetProgress.mockResolvedValue(worker);
    mockGetAvailability.mockResolvedValue([]);

    render(<WorkerHome />);

    await waitFor(() => expect(mockIdentifyClarity).toHaveBeenCalled());
    expect(mockIdentifyClarity).toHaveBeenCalledWith('auth-1', { workerId: 'worker-1', workerStatus: '' });
  });

  it('availability vazia → availability fica undefined no workerData (branch length>0 falso)', async () => {
    const worker = makeWorker({ missingFields: [] });
    mockGetProgress.mockResolvedValue(worker);
    mockGetAvailability.mockResolvedValue([]);

    render(<WorkerHome />);
    await waitFor(() => expect(mockIdentifyClarity).toHaveBeenCalled());
    expect(screen.getByTestId('jobs-embedded-section')).toBeInTheDocument();
  });
});

// ── Fetch com sucesso — cadastro incompleto ──────────────────────────────────

describe('WorkerHome — cadastro incompleto (missingFields com pendência)', () => {
  it('PendingTasksCard aparece com os missingFields e a profession crus; JobsEmbeddedSection incompleto', async () => {
    const worker = makeWorker({ missingFields: ['phone', 'doc_criminal_record'], profession: 'AT' });
    mockGetProgress.mockResolvedValue(worker);
    mockGetAvailability.mockResolvedValue([]);

    render(<WorkerHome />);

    await waitFor(() => expect(screen.getByTestId('pending-tasks-card')).toBeInTheDocument());
    const card = screen.getByTestId('pending-tasks-card');
    expect(card).toHaveAttribute('data-missing-fields', '["phone","doc_criminal_record"]');
    expect(card).toHaveAttribute('data-profession', 'AT');
    // Fase 3/DD4: PendingTasksCard precisa do país pra gatear a ajuda de
    // antecedentes (trâmite argentino, F12) — a home já busca isso em
    // workerData.country (GET /api/workers/me), sem fetch novo.
    expect(card).toHaveAttribute('data-country', 'AR');

    const jobs = screen.getByTestId('jobs-embedded-section');
    expect(jobs).toHaveAttribute('data-registration-complete', 'false');
    expect(jobs).toHaveAttribute('data-missing-fields', '["phone","doc_criminal_record"]');
  });
});

// ── Completude NÃO apurada (missingFields null) ──────────────────────────────

describe('WorkerHome — completude não apurada (missingFields null/ausente)', () => {
  it('null é fail-closed: NÃO é tratado como completo nem como "tem pendência conhecida" (sem card, sem afirmar completo)', async () => {
    const worker = makeWorker({ missingFields: null });
    mockGetProgress.mockResolvedValue(worker);
    mockGetAvailability.mockResolvedValue([]);

    render(<WorkerHome />);

    await waitFor(() => expect(mockIdentifyClarity).toHaveBeenCalled());
    const jobs = screen.getByTestId('jobs-embedded-section');
    // Fail-closed (D302/camada 0): null NUNCA vira "registro completo".
    expect(jobs).toHaveAttribute('data-registration-complete', 'false');
    // Sem tokens conhecidos, não há linha para montar — o card não aparece,
    // mas isso não afirma completude (JobsEmbeddedSection acima já barra).
    expect(screen.queryByTestId('pending-tasks-card')).not.toBeInTheDocument();
  });
});

// ── Falha no fetch ────────────────────────────────────────────────────────────

describe('WorkerHome — falha no fetch', () => {
  it('getProgress rejeita → console.error, workerData null, JobsEmbeddedSection incompleto sem missingFields', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGetProgress.mockRejectedValue(new Error('network down'));
    mockGetAvailability.mockResolvedValue([]);

    render(<WorkerHome />);

    await waitFor(() => {
      expect(screen.getByTestId('jobs-embedded-section')).toHaveAttribute('data-registration-complete', 'false');
    });
    expect(screen.getByTestId('jobs-embedded-section')).toHaveAttribute('data-missing-fields', 'null');
    expect(consoleSpy).toHaveBeenCalledWith('Failed to fetch worker data:', expect.any(Error));
    consoleSpy.mockRestore();
  });
});

// ── userName / avatar fallback ────────────────────────────────────────────────

describe('WorkerHome — fallback de nome e avatar', () => {
  it('user.name presente → usado no AppLayout/TopNavbar', async () => {
    mockGetProgress.mockResolvedValue(makeWorker());
    mockGetAvailability.mockResolvedValue([]);
    render(<WorkerHome />);
    expect(screen.getByTestId('app-layout')).toHaveAttribute('data-username', 'Ana Prestadora');
    expect(screen.getByTestId('top-navbar')).toHaveTextContent('Ana Prestadora');
    await waitFor(() => expect(mockGetProgress).toHaveBeenCalled());
  });

  it('user.name vazio → cai no fallback common.userFallback', async () => {
    mockUser = { id: 'worker-1', name: '' };
    mockGetProgress.mockResolvedValue(makeWorker());
    mockGetAvailability.mockResolvedValue([]);
    render(<WorkerHome />);
    expect(screen.getByTestId('app-layout')).toHaveAttribute('data-username', 'common.userFallback');
    await waitFor(() => expect(mockGetProgress).toHaveBeenCalled());
  });

  it('profilePhoto presente é repassado (truthy) sem quebrar', async () => {
    mockProfilePhoto = 'https://cdn.test/photo.jpg';
    mockGetProgress.mockResolvedValue(makeWorker());
    mockGetAvailability.mockResolvedValue([]);
    render(<WorkerHome />);
    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
    await waitFor(() => expect(mockGetProgress).toHaveBeenCalled());
  });
});
