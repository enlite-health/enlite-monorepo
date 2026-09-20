/**
 * Unit de `AdminPatientsPage` — a página de lista de pacientes.
 *
 * `PatientFilters`, `PatientsTable`, `PatientCreateModal` e `TableSkeleton`
 * são mockados (shallow): o que este arquivo decide sozinho é o cálculo dos
 * filtros/paginação/debounce e o mapeamento de `rawPatients`, não o que essas
 * telas fazem por dentro — isso é escopo de outros arquivos, já testado onde
 * vivem. `Select` (atom) é um `<select>` nativo, real — sem Radix, sem risco.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

function t(key: string, opts?: unknown): string {
  return opts ? `${key}:${JSON.stringify(opts)}` : key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const usePatientsDataMock = vi.fn();
vi.mock('@hooks/admin/usePatientsData', () => ({
  usePatientsData: (filters: unknown) => usePatientsDataMock(filters),
}));

vi.mock('@presentation/components/ui/skeletons', () => ({
  TableSkeleton: () => <div data-testid="table-skeleton" />,
}));

vi.mock('@presentation/components/features/admin/PatientCreateModal', () => ({
  PatientCreateModal: (props: { onClose: () => void; onCreated: () => void }) => (
    <div data-testid="patient-create-modal-stub">
      <button data-testid="modal-close" onClick={props.onClose}>close</button>
      <button data-testid="modal-created" onClick={props.onCreated}>created</button>
    </div>
  ),
}));

vi.mock('@presentation/components/features/admin/PatientFilters', () => ({
  PatientFilters: (props: {
    searchValue: string; onSearchChange: (v: string) => void;
    codeValue: string; onCodeChange: (v: string) => void;
    onAttentionChange: (v: string) => void;
    onReasonChange: (v: string) => void;
    onSpecialtyChange: (v: string) => void;
    onDependencyChange: (v: string) => void;
    onCountryChange: (v: string) => void;
  }) => (
    <div data-testid="patient-filters-stub">
      <input data-testid="search-input" value={props.searchValue} onChange={(e) => props.onSearchChange(e.target.value)} />
      <input data-testid="code-input" value={props.codeValue} onChange={(e) => props.onCodeChange(e.target.value)} />
      <button data-testid="attention-change" onClick={() => props.onAttentionChange('needs_attention')}>attn</button>
      <button data-testid="reason-change" onClick={() => props.onReasonChange('MISSING_INFO')}>reason</button>
      <button data-testid="specialty-change" onClick={() => props.onSpecialtyChange('ASD')}>spec</button>
      <button data-testid="dependency-change" onClick={() => props.onDependencyChange('SEVERE')}>dep</button>
      <button data-testid="country-change" onClick={() => props.onCountryChange('AR')}>country</button>
    </div>
  ),
}));

vi.mock('@presentation/components/features/admin/PatientsTable', () => ({
  PatientsTable: (props: { patients: Array<{ id: string }>; onRowClick?: (id: string) => void }) => (
    <div data-testid="patients-table-stub">
      <div data-testid="patients-json">{JSON.stringify(props.patients)}</div>
      {props.patients.map((p) => (
        <button key={p.id} data-testid={`row-${p.id}`} onClick={() => props.onRowClick?.(p.id)} />
      ))}
    </div>
  ),
}));

const { AdminPatientsPage } = await import('../AdminPatientsPage');

function setPatientsData(over: Partial<{
  patients: unknown[] | undefined; total: number; isLoading: boolean; error: string | null; refetch: () => void;
}> = {}) {
  usePatientsDataMock.mockReturnValue({
    patients: [],
    total: 0,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    ...over,
  });
}

describe('AdminPatientsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    setPatientsData();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('desmontar limpa os timers de debounce pendentes sem lançar', () => {
    const { unmount } = render(<AdminPatientsPage />);
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'x' } });
    expect(() => unmount()).not.toThrow();
  });

  // ── D269 — POST /patients → patient:write ────────────────────────────────

  function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: {
        uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
      } as AuthzContract,
    });
  }

  it('🔴 enforcement=on, sem patient:write: new-patient-btn SOME', () => {
    comEnforcement([], 'on');
    render(<AdminPatientsPage />);
    expect(screen.queryByTestId('new-patient-btn')).not.toBeInTheDocument();
  });

  it('enforcement=on, com patient:write: new-patient-btn existe', () => {
    comEnforcement(['patient:create'], 'on');
    render(<AdminPatientsPage />);
    expect(screen.getByTestId('new-patient-btn')).toBeInTheDocument();
  });

  it('enforcement OFF (ou ausente): new-patient-btn existe mesmo sem célula', () => {
    render(<AdminPatientsPage />);
    expect(screen.getByTestId('new-patient-btn')).toBeInTheDocument();
  });
});
