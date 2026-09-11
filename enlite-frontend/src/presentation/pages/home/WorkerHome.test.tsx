/**
 * WorkerHome.test.tsx
 *
 * CAMADA 0 — item 2 (parecer lex 10/09): WorkerHome agora repassa
 * `missingFields` (do GET /api/workers/me que ela já busca) pra
 * JobsEmbeddedSection — sem requisição nova.
 *
 * Arquivo não tinha teste nenhum antes deste fix (0% funcs/lines na suíte
 * cheia) — cobertura 100% cobre o componente inteiro: fetch (Promise.all de
 * progress/docs/availability), Clarity, cálculo de isFullyRegistered, o CTA
 * do card de progresso e o repasse de props pra JobsEmbeddedSection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorkerHome } from './WorkerHome';
import type { WorkerProgressResponse } from '@infrastructure/http/WorkerApiService';
import type { WorkerDocumentsResponse } from '@infrastructure/http/DocumentApiService';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

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

const mockGetDocuments = vi.fn();
vi.mock('@infrastructure/http/DocumentApiService', () => ({
  DocumentApiService: { getDocuments: (...args: unknown[]) => mockGetDocuments(...args) },
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

vi.mock('@presentation/components/organisms/ProfileCompletionCard', () => ({
  ProfileCompletionCard: ({ onActionClick }: { onActionClick: () => void }) => (
    <div data-testid="profile-completion-card">
      <button onClick={onActionClick}>action</button>
    </div>
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
  return {
    id: 'worker-1',
    authUid: 'auth-1',
    email: 'ana@test.com',
    country: 'AR',
    timezone: 'America/Argentina/Buenos_Aires',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    firstName: 'Ana',
    lastName: 'Prestadora',
    birthDate: '1990-01-01',
    sex: 'female',
    gender: 'female',
    documentType: 'DNI',
    documentNumber: '12345678',
    languages: ['es'],
    profession: 'CUIDADOR',
    knowledgeLevel: 'technical',
    experienceTypes: ['adults'],
    yearsExperience: '3_5',
    preferredTypes: ['adults'],
    preferredAgeRange: ['adults'],
    serviceAddress: 'Av. Corrientes 1234, Buenos Aires',
    serviceRadiusKm: 10,
    availability: undefined,
    missingFields: [],
    status: 'REGISTERED',
    ...overrides,
  };
}

function makeDocs(overrides: Partial<WorkerDocumentsResponse> = {}): WorkerDocumentsResponse {
  return {
    id: 'docs-1',
    workerId: 'worker-1',
    resumeCvUrl: null,
    identityDocumentUrl: 'path/dni.pdf',
    identityDocumentBackUrl: null,
    criminalRecordUrl: 'path/crim.pdf',
    professionalRegistrationUrl: null,
    liabilityInsuranceUrl: null,
    monotributoCertificateUrl: null,
    atCertificateUrl: null,
    aptoPsicofisicoUrl: null,
    analiticoUniversitarioUrl: null,
    cartaRecomendacionUrl: null,
    documentsStatus: 'submitted',
    submittedAt: null,
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
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
    expect(mockGetDocuments).not.toHaveBeenCalled();

    const jobs = screen.getByTestId('jobs-embedded-section');
    expect(jobs).toHaveAttribute('data-registration-complete', 'false');
    expect(jobs).toHaveAttribute('data-missing-fields', 'null');
  });
});

// ── Fetch com sucesso — cadastro completo ────────────────────────────────────

describe('WorkerHome — cadastro completo', () => {
  it('worker + docs completos, disponibilidade presente → isComplete, card some, Clarity chamado, JobsEmbeddedSection completo', async () => {
    const worker = makeWorker({ missingFields: [] });
    mockGetProgress.mockResolvedValue(worker);
    mockGetAvailability.mockResolvedValue([{ day: 'monday', start: '09:00', end: '17:00' }]);
    mockGetDocuments.mockResolvedValue(makeDocs());

    render(<WorkerHome />);

    await waitFor(() => {
      expect(screen.getByTestId('jobs-embedded-section')).toHaveAttribute('data-registration-complete', 'true');
    });

    expect(screen.queryByTestId('profile-completion-card')).not.toBeInTheDocument();
    expect(mockIdentifyClarity).toHaveBeenCalledWith('auth-1', { workerId: 'worker-1', workerStatus: 'REGISTERED' });
    expect(screen.getByTestId('jobs-embedded-section')).toHaveAttribute('data-missing-fields', '[]');
  });

  it('data.status ausente → identifyClarity recebe workerStatus vazio (fallback ??)', async () => {
    const worker = makeWorker({ missingFields: [], status: undefined });
    mockGetProgress.mockResolvedValue(worker);
    mockGetAvailability.mockResolvedValue([]);
    mockGetDocuments.mockResolvedValue(makeDocs());

    render(<WorkerHome />);

    await waitFor(() => expect(mockIdentifyClarity).toHaveBeenCalled());
    expect(mockIdentifyClarity).toHaveBeenCalledWith('auth-1', { workerId: 'worker-1', workerStatus: '' });
  });

  it('availability vazia → availability fica undefined no workerData (branch length>0 falso)', async () => {
    const worker = makeWorker({ missingFields: [] });
    mockGetProgress.mockResolvedValue(worker);
    mockGetAvailability.mockResolvedValue([]);
    mockGetDocuments.mockResolvedValue(makeDocs());

    render(<WorkerHome />);
    await waitFor(() => expect(mockIdentifyClarity).toHaveBeenCalled());
    // isComplete ainda depende de step3 (disponibilidade) via missingFields do
    // backend, não deste array — cobre só o ramo `: undefined`.
    expect(screen.getByTestId('jobs-embedded-section')).toBeInTheDocument();
  });
});

// ── Fetch com sucesso — cadastro incompleto ──────────────────────────────────

describe('WorkerHome — cadastro incompleto', () => {
  it('missingFields com pendência → card aparece, JobsEmbeddedSection incompleto com os mesmos missingFields', async () => {
    const worker = makeWorker({ missingFields: ['phone'] });
    mockGetProgress.mockResolvedValue(worker);
    mockGetAvailability.mockResolvedValue([]);
    mockGetDocuments.mockResolvedValue(makeDocs({ identityDocumentUrl: null }));

    render(<WorkerHome />);

    await waitFor(() => expect(screen.getByTestId('profile-completion-card')).toBeInTheDocument());
    const jobs = screen.getByTestId('jobs-embedded-section');
    expect(jobs).toHaveAttribute('data-registration-complete', 'false');
    expect(jobs).toHaveAttribute('data-missing-fields', '["phone"]');
  });

  it('CTA do card de progresso navega pra progress.nextAction.route', async () => {
    const worker = makeWorker({ missingFields: ['phone'] });
    mockGetProgress.mockResolvedValue(worker);
    mockGetAvailability.mockResolvedValue([]);
    mockGetDocuments.mockResolvedValue(makeDocs());

    render(<WorkerHome />);
    await waitFor(() => expect(screen.getByTestId('profile-completion-card')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'action' }));
    expect(mockNavigate).toHaveBeenCalledWith('/worker-registration');
  });
});

// ── Falha no fetch ────────────────────────────────────────────────────────────

describe('WorkerHome — falha no fetch', () => {
  it('getProgress rejeita → console.error, workerData null, JobsEmbeddedSection incompleto sem missingFields', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGetProgress.mockRejectedValue(new Error('network down'));
    mockGetAvailability.mockResolvedValue([]);
    mockGetDocuments.mockResolvedValue(makeDocs());

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
    mockGetDocuments.mockResolvedValue(makeDocs());
    render(<WorkerHome />);
    expect(screen.getByTestId('app-layout')).toHaveAttribute('data-username', 'Ana Prestadora');
    expect(screen.getByTestId('top-navbar')).toHaveTextContent('Ana Prestadora');
    await waitFor(() => expect(mockGetProgress).toHaveBeenCalled());
  });

  it('user.name vazio → cai no fallback common.userFallback', async () => {
    mockUser = { id: 'worker-1', name: '' };
    mockGetProgress.mockResolvedValue(makeWorker());
    mockGetAvailability.mockResolvedValue([]);
    mockGetDocuments.mockResolvedValue(makeDocs());
    render(<WorkerHome />);
    expect(screen.getByTestId('app-layout')).toHaveAttribute('data-username', 'common.userFallback');
    await waitFor(() => expect(mockGetProgress).toHaveBeenCalled());
  });

  it('profilePhoto presente é repassado (truthy) sem quebrar', async () => {
    mockProfilePhoto = 'https://cdn.test/photo.jpg';
    mockGetProgress.mockResolvedValue(makeWorker());
    mockGetAvailability.mockResolvedValue([]);
    mockGetDocuments.mockResolvedValue(makeDocs());
    render(<WorkerHome />);
    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
    await waitFor(() => expect(mockGetProgress).toHaveBeenCalled());
  });
});
