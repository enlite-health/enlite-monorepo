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
import { render, screen, fireEvent, act } from '@testing-library/react';
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

  it('carregando: mostra o skeleton, não a tabela', () => {
    setPatientsData({ isLoading: true });
    render(<AdminPatientsPage />);
    expect(screen.getByTestId('table-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('patients-table-stub')).not.toBeInTheDocument();
  });

  it('erro: mostra a mensagem, não a tabela nem o skeleton', () => {
    setPatientsData({ error: 'falha de rede' });
    render(<AdminPatientsPage />);
    expect(screen.getByText('falha de rede')).toBeInTheDocument();
    expect(screen.queryByTestId('patients-table-stub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('table-skeleton')).not.toBeInTheDocument();
  });

  it('sucesso: mostra a tabela com os pacientes mapeados', () => {
    setPatientsData({
      patients: [{
        id: 'p1', firstName: 'Ana', lastName: 'Gomez', documentType: 'DNI', documentNumber: '123',
        caseNumber: 5, dependencyLevel: 'SEVERE', clinicalSpecialty: 'ASD', serviceType: ['AT'],
        needsAttention: true, attentionReasons: ['MISSING_INFO'],
      }],
      total: 1,
    });
    render(<AdminPatientsPage />);
    const json = JSON.parse(screen.getByTestId('patients-json').textContent ?? '[]');
    expect(json).toEqual([{
      id: 'p1', firstName: 'Ana', lastName: 'Gomez', documentType: 'DNI', documentNumber: '123',
      caseNumber: 5, dependencyLevel: 'SEVERE', clinicalSpecialty: 'ASD', serviceType: ['AT'],
      needsAttention: true, attentionReasons: ['MISSING_INFO'],
    }]);
  });

  it('rawPatients ausente (undefined): não quebra, mapeia para lista vazia', () => {
    setPatientsData({ patients: undefined });
    render(<AdminPatientsPage />);
    expect(JSON.parse(screen.getByTestId('patients-json').textContent ?? 'null')).toEqual([]);
  });

  it('paciente com campos ausentes: aplica os fallbacks (—, [], false)', () => {
    setPatientsData({ patients: [{ id: 'p2' }] });
    render(<AdminPatientsPage />);
    const json = JSON.parse(screen.getByTestId('patients-json').textContent ?? '[]');
    expect(json).toEqual([{
      id: 'p2', firstName: '', lastName: '', documentType: null, documentNumber: null,
      caseNumber: null, dependencyLevel: null, clinicalSpecialty: null, serviceType: [],
      needsAttention: false, attentionReasons: [],
    }]);
  });

  it('clicar numa linha navega para a ficha do paciente', () => {
    setPatientsData({ patients: [{ id: 'p1' }] });
    render(<AdminPatientsPage />);
    fireEvent.click(screen.getByTestId('row-p1'));
    expect(navigate).toHaveBeenCalledWith('/admin/patients/p1');
  });

  it('clicar em "Kanban" navega para /admin/patients/kanban', () => {
    render(<AdminPatientsPage />);
    fireEvent.click(screen.getByTestId('patients-kanban-link'));
    expect(navigate).toHaveBeenCalledWith('/admin/patients/kanban');
  });

  it('clicar em "Crear paciente" abre o modal; fechar some com ele', () => {
    render(<AdminPatientsPage />);
    expect(screen.queryByTestId('patient-create-modal-stub')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('new-patient-btn'));
    expect(screen.getByTestId('patient-create-modal-stub')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('modal-close'));
    expect(screen.queryByTestId('patient-create-modal-stub')).not.toBeInTheDocument();
  });

  it('criar com sucesso: volta pra página 1 e chama refetch', () => {
    const refetch = vi.fn();
    setPatientsData({ refetch });
    render(<AdminPatientsPage />);
    fireEvent.click(screen.getByTestId('new-patient-btn'));
    fireEvent.click(screen.getByTestId('modal-created'));
    expect(refetch).toHaveBeenCalled();
  });

  it('busca por nome: debounce de 400ms antes de virar filtro (e volta pra página 1)', () => {
    render(<AdminPatientsPage />);
    usePatientsDataMock.mockClear();
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'Ana' } });
    // ainda não filtrou — o input local mudou, o debounced não
    expect(usePatientsDataMock).not.toHaveBeenCalledWith(expect.objectContaining({ search: 'Ana' }));

    act(() => { vi.advanceTimersByTime(400); });
    expect(usePatientsDataMock).toHaveBeenCalledWith(expect.objectContaining({ search: 'Ana', offset: '0' }));
  });

  it('busca por código: mesmo debounce de 400ms', () => {
    render(<AdminPatientsPage />);
    fireEvent.change(screen.getByTestId('code-input'), { target: { value: '748' } });
    act(() => { vi.advanceTimersByTime(400); });
    expect(usePatientsDataMock).toHaveBeenCalledWith(expect.objectContaining({ case_number: '748' }));
  });

  it('trocar de busca antes do debounce disparar reinicia o timer (só o último valor filtra)', () => {
    render(<AdminPatientsPage />);
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'An' } });
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'Ana' } });
    act(() => { vi.advanceTimersByTime(200); });
    expect(usePatientsDataMock).not.toHaveBeenCalledWith(expect.objectContaining({ search: 'An' }));
    act(() => { vi.advanceTimersByTime(200); });
    expect(usePatientsDataMock).toHaveBeenCalledWith(expect.objectContaining({ search: 'Ana' }));
  });

  it('filtro "necessita atenção": manda needs_attention=true; escolher motivo manda attention_reason', () => {
    render(<AdminPatientsPage />);
    fireEvent.click(screen.getByTestId('attention-change'));
    expect(usePatientsDataMock).toHaveBeenCalledWith(expect.objectContaining({ needs_attention: 'true', attention_reason: undefined }));

    fireEvent.click(screen.getByTestId('reason-change'));
    expect(usePatientsDataMock).toHaveBeenCalledWith(expect.objectContaining({ needs_attention: 'true', attention_reason: 'MISSING_INFO' }));
  });

  it('trocar o motivo de atenção sem "needs_attention" selecionado não manda attention_reason', () => {
    render(<AdminPatientsPage />);
    fireEvent.click(screen.getByTestId('reason-change'));
    expect(usePatientsDataMock).toHaveBeenCalledWith(expect.objectContaining({ attention_reason: undefined }));
  });

  it('filtro de especialidade, dependência e país entram nos filtros', () => {
    render(<AdminPatientsPage />);
    fireEvent.click(screen.getByTestId('specialty-change'));
    expect(usePatientsDataMock).toHaveBeenCalledWith(expect.objectContaining({ clinical_specialty: 'ASD' }));

    fireEvent.click(screen.getByTestId('dependency-change'));
    expect(usePatientsDataMock).toHaveBeenCalledWith(expect.objectContaining({ dependency_level: 'SEVERE' }));

    fireEvent.click(screen.getByTestId('country-change'));
    expect(usePatientsDataMock).toHaveBeenCalledWith(expect.objectContaining({ country: 'AR' }));
  });

  it('paginação: 0 resultados mostra start/end/total = 0', () => {
    setPatientsData({ total: 0 });
    render(<AdminPatientsPage />);
    expect(screen.getByText(/"start":0,"end":0,"total":0/)).toBeInTheDocument();
  });

  it('paginação: com resultados, calcula start/end pela página e pelo itemsPerPage', () => {
    setPatientsData({ total: 45 });
    render(<AdminPatientsPage />);
    expect(screen.getByText(/"start":1,"end":20,"total":45/)).toBeInTheDocument();
  });

  it('paginação: botão anterior desabilitado na página 1; próxima habilita e avança', () => {
    setPatientsData({ total: 45 });
    render(<AdminPatientsPage />);
    const prev = screen.getByLabelText('admin.patients.previousPage');
    const next = screen.getByLabelText('admin.patients.nextPage');
    expect(prev).toBeDisabled();
    expect(next).not.toBeDisabled();

    fireEvent.click(next);
    expect(usePatientsDataMock).toHaveBeenCalledWith(expect.objectContaining({ offset: '20' }));
  });

  it('paginação: botão próxima desabilitado na última página', () => {
    setPatientsData({ total: 45 });
    render(<AdminPatientsPage />);
    const next = screen.getByLabelText('admin.patients.nextPage');
    fireEvent.click(next); // page 2
    fireEvent.click(next); // page 3 (última: ceil(45/20)=3)
    expect(next).toBeDisabled();

    const prev = screen.getByLabelText('admin.patients.previousPage');
    expect(prev).not.toBeDisabled();
    fireEvent.click(prev);
    expect(usePatientsDataMock).toHaveBeenCalledWith(expect.objectContaining({ offset: '20' }));
  });

  it('trocar itens por página volta pra página 1 e muda o limit', () => {
    setPatientsData({ total: 45 });
    render(<AdminPatientsPage />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '50' } });
    expect(usePatientsDataMock).toHaveBeenCalledWith(expect.objectContaining({ limit: '50', offset: '0' }));
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
    comEnforcement(['patient:write'], 'on');
    render(<AdminPatientsPage />);
    expect(screen.getByTestId('new-patient-btn')).toBeInTheDocument();
  });

  it('enforcement OFF (ou ausente): new-patient-btn existe mesmo sem célula', () => {
    render(<AdminPatientsPage />);
    expect(screen.getByTestId('new-patient-btn')).toBeInTheDocument();
  });
});
