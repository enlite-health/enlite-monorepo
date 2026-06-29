import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WorkerDetailPage from '../WorkerDetailPage';
import type { WorkerDetail } from '@domain/entities/Worker';

// WorkerDetailContent calls useAdminAuth (Firebase). Non-admin profile → no edit
// affordance, preserving the read-only behavior these tests assert.
vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: () => ({ adminProfile: null }),
}));

// ── react-i18next mock ────────────────────────────────────────────────────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// ── react-router-dom mocks ────────────────────────────────────────────────────
const mockNavigate = vi.fn();
const mockUseParams = vi.fn(() => ({ id: 'worker-123' }));
const mockUseLocation = vi.fn<[], { state: unknown }>(() => ({ state: null }));

vi.mock('react-router-dom', () => ({
  useParams: () => mockUseParams(),
  useNavigate: () => mockNavigate,
  useLocation: () => mockUseLocation(),
}));

// ── useWorkerDetail hook mock ─────────────────────────────────────────────────
const mockUseWorkerDetail = vi.fn();

vi.mock('@hooks/admin/useWorkerDetail', () => ({
  useWorkerDetail: (id: string | undefined) => mockUseWorkerDetail(id),
}));

vi.mock('@hooks/admin/useAdminAdditionalDocuments', () => ({
  useAdminAdditionalDocuments: () => ({
    documents: [],
    isLoading: false,
    fetchDocuments: vi.fn(),
    uploadDocument: vi.fn(),
    deleteDocument: vi.fn(),
    viewDocument: vi.fn(),
  }),
}));

// ── WorkerDetail sub-component mocks ─────────────────────────────────────────
vi.mock('@presentation/components/features/admin/WorkerDetail/WorkerContactCard', () => ({
  WorkerContactCard: (props: Record<string, unknown>) => (
    <div data-testid="worker-contact-card" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@presentation/components/features/admin/WorkerDetail/WorkerPersonalInfoCard', () => ({
  WorkerPersonalInfoCard: (props: Record<string, unknown>) => (
    <div data-testid="worker-personal-info-card" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@presentation/components/features/admin/WorkerDetail/WorkerAddressCard', () => ({
  WorkerAddressCard: (props: Record<string, unknown>) => (
    <div data-testid="worker-address-card" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@presentation/components/features/admin/WorkerDetail/WorkerProfileTabs', () => ({
  WorkerProfileTabs: ({ activeTab, onTabChange }: { activeTab: string; onTabChange: (tab: string) => void }) => (
    <div data-testid="worker-profile-tabs" data-active-tab={activeTab}>
      <button data-testid="tab-encuadres" onClick={() => onTabChange('encuadres')}>Enquadre</button>
      <button data-testid="tab-documents" onClick={() => onTabChange('documents')}>Documentos</button>
    </div>
  ),
}));

vi.mock('@presentation/components/features/admin/WorkerDetail/WorkerProfessionalCard', () => ({
  WorkerProfessionalCard: (props: Record<string, unknown>) => (
    <div data-testid="worker-professional-card" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@presentation/components/features/admin/WorkerDetail/WorkerDocumentsCard', () => ({
  WorkerDocumentsCard: ({ children, ...props }: Record<string, unknown>) => (
    <div data-testid="worker-documents-card" data-props={JSON.stringify(props)}>{children as React.ReactNode}</div>
  ),
}));

vi.mock('@presentation/components/features/admin/WorkerDetail/WorkerEncuadresCard', () => ({
  WorkerEncuadresCard: (props: Record<string, unknown>) => (
    <div data-testid="worker-encuadres-card" data-props={JSON.stringify(props)} />
  ),
}));

vi.mock('@presentation/components/organisms/AdditionalDocumentsSection', () => ({
  AdditionalDocumentsSection: () => <div data-testid="additional-documents-section" />,
}));

// Admin-only toggle calls useAdminAuth (Firebase) — out of scope here, tested separately.
vi.mock('@presentation/components/features/admin/WorkerDetail/WorkerTestAccountToggle', () => ({
  WorkerTestAccountToggle: () => <div data-testid="worker-test-account-toggle" />,
}));

// ── DetailSkeleton mock ───────────────────────────────────────────────────────
vi.mock('@presentation/components/ui/skeletons', () => ({
  DetailSkeleton: () => <div data-testid="detail-skeleton" />,
}));

// ── Fixture ───────────────────────────────────────────────────────────────────
const MOCK_WORKER: WorkerDetail = {
  id: 'worker-123',
  email: 'ana.silva@test.com',
  phone: '+55 11 99999-0000',
  whatsappPhone: '+55 11 99999-0000',
  country: 'BR',
  timezone: 'America/Sao_Paulo',
  status: 'REGISTERED',
  overallStatus: 'QUALIFIED',
  availabilityStatus: 'available',
  dataSources: ['talentum'],
  platform: 'talentum',
  createdAt: '2026-01-10T00:00:00Z',
  updatedAt: '2026-03-20T00:00:00Z',

  firstName: 'Ana',
  lastName: 'Silva',
  sex: 'F',
  gender: 'Feminino',
  birthDate: '1995-06-15',
  documentType: 'CPF',
  documentNumber: '123.456.789-00',
  profilePhotoUrl: null,

  profession: 'Psicóloga',
  occupation: 'Acompanhante Terapêutico',
  knowledgeLevel: 'Senior',
  titleCertificate: 'CRP 06/12345',
  experienceTypes: ['TEA'],
  yearsExperience: '5',
  preferredTypes: ['Presencial'],
  preferredAgeRange: ['Adulto'],
  languages: ['Português'],

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

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockNavigate.mockReset();
  mockUseParams.mockReturnValue({ id: 'worker-123' });
  mockUseLocation.mockReturnValue({ state: null });
});

// ── Loading state ─────────────────────────────────────────────────────────────

describe('WorkerDetailPage — loading state', () => {
  it('renders loading skeleton when isLoading is true', () => {
    mockUseWorkerDetail.mockReturnValue({
      worker: null,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    });

    render(<WorkerDetailPage />);

    expect(screen.getByTestId('detail-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('worker-contact-card')).not.toBeInTheDocument();
  });

  it('does not render any cards during loading', () => {
    mockUseWorkerDetail.mockReturnValue({
      worker: null,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    });

    render(<WorkerDetailPage />);

    expect(screen.queryByTestId('worker-contact-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('worker-personal-info-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('worker-address-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('worker-documents-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('worker-encuadres-card')).not.toBeInTheDocument();
  });
});

// ── Success state ─────────────────────────────────────────────────────────────

describe('WorkerDetailPage — success state', () => {
  beforeEach(() => {
    mockUseWorkerDetail.mockReturnValue({
      worker: MOCK_WORKER,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it('renders full name in the breadcrumb header', () => {
    render(<WorkerDetailPage />);
    expect(screen.getByText('Ana Silva')).toBeInTheDocument();
  });

  it('renders top-level cards and tabs', () => {
    render(<WorkerDetailPage />);

    expect(screen.getByTestId('worker-contact-card')).toBeInTheDocument();
    expect(screen.getByTestId('worker-personal-info-card')).toBeInTheDocument();
    expect(screen.getByTestId('worker-address-card')).toBeInTheDocument();
    expect(screen.getByTestId('worker-profile-tabs')).toBeInTheDocument();
    // Default tab is documents
    expect(screen.getByTestId('worker-documents-card')).toBeInTheDocument();
  });

  it('does not render the skeleton when data is loaded', () => {
    render(<WorkerDetailPage />);

    expect(screen.queryByTestId('detail-skeleton')).not.toBeInTheDocument();
  });

  it('falls back to email when firstName and lastName are null', () => {
    const workerNoName: WorkerDetail = {
      ...MOCK_WORKER,
      firstName: null,
      lastName: null,
    };

    mockUseWorkerDetail.mockReturnValue({
      worker: workerNoName,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    render(<WorkerDetailPage />);

    expect(screen.getByText('ana.silva@test.com')).toBeInTheDocument();
  });

  it('shows only firstName when lastName is null', () => {
    mockUseWorkerDetail.mockReturnValue({
      worker: { ...MOCK_WORKER, lastName: null },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    render(<WorkerDetailPage />);
    expect(screen.getByText('Ana')).toBeInTheDocument();
  });

  it('renders back button with i18n key admin.workerDetail.back', () => {
    render(<WorkerDetailPage />);
    const backButtons = screen.getAllByText('admin.workerDetail.back');
    expect(backButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('navigates to /admin/workers when the back button is clicked (no origin state)', async () => {
    const user = userEvent.setup();
    render(<WorkerDetailPage />);

    const backButtons = screen.getAllByText('admin.workerDetail.back');
    await user.click(backButtons[0]);

    expect(mockNavigate).toHaveBeenCalledWith('/admin/workers');
  });

  it('navigates back to the origin path from location.state when present', async () => {
    mockUseLocation.mockReturnValue({ state: { from: '/admin/vacancies/vac-123' } });
    const user = userEvent.setup();
    render(<WorkerDetailPage />);

    const backButtons = screen.getAllByText('admin.workerDetail.back');
    await user.click(backButtons[0]);

    expect(mockNavigate).toHaveBeenCalledWith('/admin/vacancies/vac-123');
  });

  it('calls useWorkerDetail with the id from useParams', () => {
    render(<WorkerDetailPage />);

    expect(mockUseWorkerDetail).toHaveBeenCalledWith('worker-123');
  });

  it('passes correct props to WorkerContactCard', () => {
    render(<WorkerDetailPage />);
    const card = screen.getByTestId('worker-contact-card');
    const props = JSON.parse(card.getAttribute('data-props')!);
    expect(props.status).toBe('REGISTERED');
    expect(props.email).toBe('ana.silva@test.com');
    expect(props.platform).toBe('talentum');
  });

  it('passes correct props to WorkerPersonalInfoCard', () => {
    render(<WorkerDetailPage />);
    const card = screen.getByTestId('worker-personal-info-card');
    const props = JSON.parse(card.getAttribute('data-props')!);
    expect(props.birthDate).toBe('1995-06-15');
    expect(props.sex).toBe('F');
    expect(props.gender).toBe('Feminino');
    expect(props.languages).toEqual(['Português']);
  });

  it('passes correct props to WorkerAddressCard', () => {
    render(<WorkerDetailPage />);
    const card = screen.getByTestId('worker-address-card');
    const props = JSON.parse(card.getAttribute('data-props')!);
    expect(props.serviceAreas).toEqual([]);
    expect(props.location).toBeNull();
  });

  it('passes correct props to WorkerDocumentsCard (default tab)', () => {
    render(<WorkerDetailPage />);
    const card = screen.getByTestId('worker-documents-card');
    const props = JSON.parse(card.getAttribute('data-props')!);
    expect(props.documents).toBeNull();
  });

  it('switches to encuadres tab and renders WorkerEncuadresCard', async () => {
    const user = userEvent.setup();
    render(<WorkerDetailPage />);

    await user.click(screen.getByTestId('tab-encuadres'));

    expect(screen.getByTestId('worker-encuadres-card')).toBeInTheDocument();
    const card = screen.getByTestId('worker-encuadres-card');
    const props = JSON.parse(card.getAttribute('data-props')!);
    expect(props.encuadres).toEqual([]);
  });
});

// ── Error state ───────────────────────────────────────────────────────────────

describe('WorkerDetailPage — error state', () => {
  it('renders error message when error is set', () => {
    mockUseWorkerDetail.mockReturnValue({
      worker: null,
      isLoading: false,
      error: 'Worker not found',
      refetch: vi.fn(),
    });

    render(<WorkerDetailPage />);

    expect(screen.getByText('Worker not found')).toBeInTheDocument();
    expect(screen.queryByTestId('detail-skeleton')).not.toBeInTheDocument();
    expect(screen.queryByTestId('worker-contact-card')).not.toBeInTheDocument();
  });

  it('renders the notFound i18n key when worker is null with no error', () => {
    mockUseWorkerDetail.mockReturnValue({
      worker: null,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    render(<WorkerDetailPage />);

    expect(screen.getByText('admin.workerDetail.notFound')).toBeInTheDocument();
  });

  it('renders back button with i18n key in error state', () => {
    mockUseWorkerDetail.mockReturnValue({
      worker: null,
      isLoading: false,
      error: 'Failed to load',
      refetch: vi.fn(),
    });

    render(<WorkerDetailPage />);

    expect(screen.getByText('admin.workerDetail.back')).toBeInTheDocument();
  });

  it('back button navigates to /admin/workers in error state', async () => {
    const user = userEvent.setup();

    mockUseWorkerDetail.mockReturnValue({
      worker: null,
      isLoading: false,
      error: 'Failed to load',
      refetch: vi.fn(),
    });

    render(<WorkerDetailPage />);

    await user.click(screen.getByText('admin.workerDetail.back'));

    expect(mockNavigate).toHaveBeenCalledWith('/admin/workers');
  });

  it('does not render any cards in error state', () => {
    mockUseWorkerDetail.mockReturnValue({
      worker: null,
      isLoading: false,
      error: 'Some error',
      refetch: vi.fn(),
    });

    render(<WorkerDetailPage />);

    expect(screen.queryByTestId('worker-contact-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('worker-personal-info-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('worker-address-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('worker-documents-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('worker-encuadres-card')).not.toBeInTheDocument();
  });
});
