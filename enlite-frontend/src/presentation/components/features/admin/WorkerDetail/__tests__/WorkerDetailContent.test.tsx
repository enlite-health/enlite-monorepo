import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { WorkerDetailContent } from '../WorkerDetailContent';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { WorkerDetail } from '@domain/entities/Worker';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, opts?: any) => opts?.defaultValue ?? k }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

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

describe('WorkerDetailContent', () => {
  beforeEach(() => {
    vi.mocked(AdminApiService.getWorkerById).mockReset().mockResolvedValue(worker);
    vi.mocked(AdminApiService.getWorkerAdditionalDocs).mockReset().mockResolvedValue([]);
    vi.mocked(AdminApiService.listWorkerTags).mockReset().mockResolvedValue([]);
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
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

  it('sucesso, allowEdit=false (default): botão de editar perfil não aparece — o toggle de teste é independente de allowEdit', async () => {
    render(<WorkerDetailContent workerId="w1" />);
    await screen.findByText('Juana Pérez');
    expect(screen.queryByTestId('worker-edit-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('worker-test-account-checkbox')).toBeInTheDocument();
  });

  it('sucesso, allowEdit=true (engine desligado): edita e reabre o modal', async () => {
    render(<WorkerDetailContent workerId="w1" allowEdit header={<div data-testid="hdr">header</div>} />);
    await screen.findByText('Juana Pérez');
    expect(screen.getByTestId('hdr')).toBeInTheDocument();
    expect(screen.getByTestId('worker-test-account-checkbox')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('worker-edit-button'));
    expect(screen.getByTestId('worker-edit-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('worker-edit-modal-backdrop'));
    await waitFor(() => expect(screen.queryByTestId('worker-edit-modal')).not.toBeInTheDocument());
  });

  it('allowEdit=true mas SEM worker:write (engine ON): não pode editar', async () => {
    comEnforcement(['worker:read', 'worker_pii:read'], 'on');
    render(<WorkerDetailContent workerId="w1" allowEdit />);
    await screen.findByText(/admin.workerDetail.birthDate/);
    expect(screen.queryByTestId('worker-edit-button')).not.toBeInTheDocument();
  });

  it('allowEdit=true COM worker:write (engine ON): o botão de editar aparece', async () => {
    comEnforcement(['worker:read', 'worker_pii:read', 'worker:write'], 'on');
    render(<WorkerDetailContent workerId="w1" allowEdit />);
    await screen.findByText(/admin.workerDetail.birthDate/);
    expect(screen.getByTestId('worker-edit-button')).toBeInTheDocument();
  });

  it('worker sem serviceAreas/encuadres (campos ausentes): os cards caem na lista vazia, sem quebrar', async () => {
    const semListas = { ...worker } as Record<string, unknown>;
    delete semListas.serviceAreas;
    delete semListas.encuadres;
    vi.mocked(AdminApiService.getWorkerById).mockResolvedValue(semListas as never);
    render(<WorkerDetailContent workerId="w1" />);
    await screen.findByText('Juana Pérez');

    fireEvent.click(screen.getByRole('button', { name: /admin.workerDetail.tabs.encuadres/i }));
    expect(screen.getByText(/admin.workerDetail.addressData/)).toBeInTheDocument();
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

  it('D269 — enforcement=on com worker_document:read mas sem :write/:delete: a seção existe e "Agregar" SOME', async () => {
    comEnforcement(['worker:read', 'worker_contact:read', 'worker_document:read'], 'on');
    render(<WorkerDetailContent workerId="w1" />);
    await screen.findByText('Juana Pérez');
    expect(screen.getByTestId('worker-documents-card')).toBeInTheDocument();
    expect(screen.queryByTestId('additional-doc-add')).not.toBeInTheDocument();
  });

  it('D269 — enforcement=on com worker_document:read+write: "Agregar" existe na seção de docs adicionais', async () => {
    comEnforcement(['worker:read', 'worker_contact:read', 'worker_document:read', 'worker_document:write'], 'on');
    render(<WorkerDetailContent workerId="w1" />);
    await screen.findByText('Juana Pérez');
    expect(screen.getByTestId('additional-doc-add')).toBeInTheDocument();
  });

  // ── D286 fase 2: containers e abas ──────────────────────────────────────────────────────────
  describe('D286 — cada container tem célula própria; aba sem container legível some', () => {
    it('só worker:read: sem card de contato, sem dossiê (só idiomas e etiquetas), sem endereço; abas documents/encuadres somem, placeholders ficam', async () => {
      comEnforcement(['worker:read'], 'on');
      render(<WorkerDetailContent workerId="w1" />);
      await screen.findByText('admin.workerDetail.personalInfo');
      // contato (nome na card de contato) e dossiê
      expect(screen.queryByText('Juana Pérez')).not.toBeInTheDocument();
      expect(screen.queryByText(/admin.workerDetail.birthDate/)).not.toBeInTheDocument();
      expect(screen.getAllByText(/admin.workerDetail.languages/).length).toBeGreaterThan(0);
      expect(screen.queryByTestId('worker-edit-button')).not.toBeInTheDocument();
      // abas: documents e encuadres somem; availability (operacional) e placeholders ficam
      expect(screen.queryByRole('button', { name: /admin.workerDetail.tabs.documents/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /admin.workerDetail.tabs.encuadres/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /admin.workerDetail.tabs.availability/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /admin.workerDetail.tabs.financial/i })).toBeInTheDocument();
      // a aba ativa (documents, default) sumiu → cai na primeira visível
      expect(screen.queryByTestId('worker-documents-card')).not.toBeInTheDocument();
    });

    it('worker_pii:read sem contato nem endereço: dossiê aparece, nome não, card de endereço não', async () => {
      comEnforcement(['worker:read', 'worker_pii:read'], 'on');
      render(<WorkerDetailContent workerId="w1" />);
      await screen.findByText(/admin.workerDetail.birthDate/);
      expect(screen.queryByText('Juana Pérez')).not.toBeInTheDocument();
      expect(screen.queryByText(/admin.workerDetail.addressData/)).not.toBeInTheDocument();
    });

    it('worker_address:read (a mesma célula do mapa) devolve o card de endereço', async () => {
      comEnforcement(['worker:read', 'worker_address:read'], 'on');
      render(<WorkerDetailContent workerId="w1" />);
      await screen.findByText('admin.workerDetail.personalInfo');
      expect(screen.getByText(/admin.workerDetail.addressData/)).toBeInTheDocument();
    });

    it('match:read: a aba de encuadres existe', async () => {
      comEnforcement(['worker:read', 'match:read'], 'on');
      render(<WorkerDetailContent workerId="w1" />);
      await screen.findByText('admin.workerDetail.personalInfo');
      expect(screen.getByRole('button', { name: /admin.workerDetail.tabs.encuadres/i })).toBeInTheDocument();
    });

    it('enforcement=off (ou engine indeciso): tudo aparece, como antes', async () => {
      comEnforcement([], 'off');
      render(<WorkerDetailContent workerId="w1" />);
      await screen.findByText('Juana Pérez');
      expect(screen.getByTestId('worker-documents-card')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /admin.workerDetail.tabs.encuadres/i })).toBeInTheDocument();
    });
  });
});
