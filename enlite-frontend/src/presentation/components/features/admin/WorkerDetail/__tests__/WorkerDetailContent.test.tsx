import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { WorkerDetailContent } from '../WorkerDetailContent';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { EnliteRole } from '@domain/entities/EnliteRole';
import type { WorkerDetail } from '@domain/entities/Worker';
import type { AdminUser } from '@domain/entities/AdminUser';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, opts?: any) => opts?.defaultValue ?? k }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

let mockAdminProfile: AdminUser | null = null;
vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: () => ({ adminProfile: mockAdminProfile }),
}));

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getWorkerById: vi.fn(),
    getWorkerAdditionalDocs: vi.fn().mockResolvedValue([]),
    listWorkerTags: vi.fn().mockResolvedValue([]),
    updateWorkerTestFlag: vi.fn(),
  },
}));

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
    } as AuthzContract,
  });
}

const worker: WorkerDetail = {
  id: 'w1',
  email: 'worker@example.com',
  phone: null,
  whatsappPhone: null,
  country: 'AR',
  timezone: 'America/Argentina/Buenos_Aires',
  status: 'REGISTERED',
  overallStatus: null,
  availabilityStatus: null,
  dataSources: [],
  platform: 'app',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  firstName: 'Juana',
  lastName: 'Pérez',
  sex: null,
  gender: null,
  birthDate: null,
  documentType: 'DNI',
  documentNumber: '12345678',
  profilePhotoUrl: null,
  profession: 'AT',
  occupation: null,
  knowledgeLevel: null,
  titleCertificate: null,
  experienceTypes: [],
  yearsExperience: null,
  preferredTypes: [],
  preferredAgeRange: [],
  languages: [],
  sexualOrientation: null,
  race: null,
  religion: null,
  weightKg: null,
  heightCm: null,
  hobbies: [],
  diagnosticPreferences: [],
  linkedinUrl: null,
  isMatchable: true,
  isActive: true,
  isTest: false,
  documents: null,
  serviceAreas: [],
  location: null,
  encuadres: [],
};

const adminProfile: AdminUser = { id: 'a1', role: EnliteRole.ADMIN } as unknown as AdminUser;

describe('WorkerDetailContent', () => {
  beforeEach(() => {
    vi.mocked(AdminApiService.getWorkerById).mockReset().mockResolvedValue(worker);
    vi.mocked(AdminApiService.getWorkerAdditionalDocs).mockReset().mockResolvedValue([]);
    vi.mocked(AdminApiService.listWorkerTags).mockReset().mockResolvedValue([]);
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    mockAdminProfile = null;
  });

  it('estado de carregamento: mostra o skeleton', () => {
    vi.mocked(AdminApiService.getWorkerById).mockReturnValue(new Promise(() => {}));
    render(<WorkerDetailContent workerId="w1" />);
    expect(screen.queryByText('Juana Pérez')).not.toBeInTheDocument();
  });

  it('sem workerId: não busca nada e some do loading (renderError customizado é usado no erro)', () => {
    const renderError = vi.fn((msg: string) => <div data-testid="custom-error">{msg}</div>);
    render(<WorkerDetailContent workerId={undefined} renderError={renderError} />);
    expect(AdminApiService.getWorkerById).not.toHaveBeenCalled();
  });

  it('erro ao buscar: usa renderError quando fornecido', async () => {
    vi.mocked(AdminApiService.getWorkerById).mockRejectedValue(new Error('falhou ao buscar'));
    const renderError = (msg: string) => <div data-testid="custom-error">{msg}</div>;
    render(<WorkerDetailContent workerId="w1" renderError={renderError} />);
    expect(await screen.findByTestId('custom-error')).toHaveTextContent('falhou ao buscar');
  });

  it('erro ao buscar sem renderError: mostra o fallback default', async () => {
    vi.mocked(AdminApiService.getWorkerById).mockRejectedValue(new Error('falhou ao buscar'));
    render(<WorkerDetailContent workerId="w1" />);
    expect(await screen.findByText('falhou ao buscar')).toBeInTheDocument();
  });

  it('sucesso, allowEdit=false (default): botão de editar perfil não aparece (mesmo sendo ADMIN) — o toggle de teste é independente de allowEdit', async () => {
    mockAdminProfile = adminProfile;
    render(<WorkerDetailContent workerId="w1" />);
    await screen.findByText('Juana Pérez');
    expect(screen.queryByTestId('worker-edit-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('worker-test-account-checkbox')).toBeInTheDocument();
  });

  it('sucesso, allowEdit=true + role ADMIN: edita e reabre o modal', async () => {
    mockAdminProfile = adminProfile;
    render(<WorkerDetailContent workerId="w1" allowEdit header={<div data-testid="hdr">header</div>} />);
    await screen.findByText('Juana Pérez');
    expect(screen.getByTestId('hdr')).toBeInTheDocument();
    expect(screen.getByTestId('worker-test-account-checkbox')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('worker-edit-button'));
    expect(screen.getByTestId('worker-edit-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('worker-edit-modal-backdrop'));
    await waitFor(() => expect(screen.queryByTestId('worker-edit-modal')).not.toBeInTheDocument());
  });

  it('allowEdit=true mas role NÃO admin: não pode editar', async () => {
    mockAdminProfile = { ...adminProfile, role: EnliteRole.RECRUITER };
    render(<WorkerDetailContent workerId="w1" allowEdit />);
    await screen.findByText('Juana Pérez');
    expect(screen.queryByTestId('worker-edit-button')).not.toBeInTheDocument();
  });

  it('troca de abas: encuadres/documents/availability/financial/history', async () => {
    render(<WorkerDetailContent workerId="w1" />);
    await screen.findByText('Juana Pérez');
    expect(screen.getByTestId('worker-documents-card')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /admin.workerDetail.tabs.encuadres/i }));
    fireEvent.click(screen.getByRole('button', { name: /admin.workerDetail.tabs.availability/i }));
    fireEvent.click(screen.getByRole('button', { name: /admin.workerDetail.tabs.financial/i }));
    expect(screen.getByText(/admin.workerDetail.comingSoon/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /admin.workerDetail.tabs.history/i }));
    expect(screen.getByText(/admin.workerDetail.comingSoon/)).toBeInTheDocument();
  });

  it('busca os documentos adicionais ao montar', async () => {
    render(<WorkerDetailContent workerId="w1" />);
    await waitFor(() => expect(AdminApiService.getWorkerAdditionalDocs).toHaveBeenCalledWith('w1'));
  });

  it('D269 — enforcement=on sem worker_document:write/:delete: "Agregar" e excluir SOMEM na seção de docs adicionais', async () => {
    comEnforcement([], 'on');
    render(<WorkerDetailContent workerId="w1" />);
    await screen.findByText('Juana Pérez');
    expect(screen.queryByTestId('additional-doc-add')).not.toBeInTheDocument();
  });

  it('D269 — enforcement=on com worker_document:write: "Agregar" existe na seção de docs adicionais', async () => {
    comEnforcement(['worker_document:write'], 'on');
    render(<WorkerDetailContent workerId="w1" />);
    await screen.findByText('Juana Pérez');
    expect(screen.getByTestId('additional-doc-add')).toBeInTheDocument();
  });
});
