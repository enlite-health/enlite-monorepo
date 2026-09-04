/**
 * AdminPatientsPage.test.tsx
 *
 * O arquivo estava em 0% de cobertura: o único teste com o nome "AdminPatients"
 * (`AdminPatients.i18n.test.ts`) lê os JSON de tradução e NUNCA renderiza a
 * página. Cobertura zero num arquivo com 273 linhas não é "nada errado" — é
 * "não olhei".
 *
 * Os filhos pesados são dublês: o que se mede aqui é a PÁGINA (estado, filtros,
 * paginação, mapeamento do payload), não a tabela nem o modal, que têm teste
 * próprio.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminPatientsPage } from '../AdminPatientsPage';

// ── Dublês ────────────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && ('start' in opts || 'total' in opts) ? `${key}:${opts.start}-${opts.end}/${opts.total}` : key,
    i18n: { language: 'es' },
  }),
}));

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const usePatientsData = vi.fn();
vi.mock('@hooks/admin/usePatientsData', () => ({
  usePatientsData: (...a: unknown[]) => usePatientsData(...a),
}));

/** A tabela real tem teste próprio; aqui ela só reporta o que RECEBEU. */
vi.mock('@presentation/components/features/admin/PatientsTable', () => ({
  PatientsTable: ({ patients, onRowClick }: any) => (
    <div data-testid="tabela" data-json={JSON.stringify(patients)}>
      <button data-testid="linha" onClick={() => onRowClick(patients[0]?.id)}>linha</button>
    </div>
  ),
}));

vi.mock('@presentation/components/features/admin/PatientCreateModal', () => ({
  PatientCreateModal: ({ onClose, onCreated }: any) => (
    <div data-testid="modal">
      <button data-testid="modal-fechar" onClick={onClose}>fechar</button>
      {/* o modal real chama `onCreated(id)` com o id do paciente criado — o mock precisa passar
          um id, senão o handler receberia o evento de clique e o teste validaria uma URL falsa */}
      <button data-testid="modal-criado" onClick={() => onCreated('novo-123')}>criado</button>
    </div>
  ),
}));

/** Filtros: só os callbacks importam para a página. */
vi.mock('@presentation/components/features/admin/PatientFilters', () => ({
  PatientFilters: (p: any) => (
    <div>
      <input data-testid="f-busca" value={p.searchValue} onChange={(e) => p.onSearchChange(e.target.value)} />
      <input data-testid="f-codigo" value={p.codeValue} onChange={(e) => p.onCodeChange(e.target.value)} />
      <button data-testid="f-atencion" onClick={() => p.onAttentionChange('needs_attention')}>a</button>
      <button data-testid="f-completo" onClick={() => p.onAttentionChange('complete')}>c</button>
      <button data-testid="f-motivo" onClick={() => p.onReasonChange('MISSING_INFO')}>m</button>
      <button data-testid="f-especialidad" onClick={() => p.onSpecialtyChange('ASD')}>e</button>
      <button data-testid="f-dependencia" onClick={() => p.onDependencyChange('SEVERE')}>d</button>
      <button data-testid="f-pais" onClick={() => p.onCountryChange('AR')}>p</button>
      <span data-testid="f-motivo-atual">{p.selectedReason}</span>
    </div>
  ),
}));

vi.mock('@presentation/components/atoms/Select', () => ({
  Select: ({ value, onValueChange }: any) => (
    <button data-testid="por-pagina" data-value={value} onClick={() => onValueChange('10')}>{value}</button>
  ),
}));

vi.mock('@presentation/components/ui/skeletons', () => ({
  TableSkeleton: () => <div data-testid="skeleton" />,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const refetch = vi.fn();

function comDados(over: Record<string, unknown> = {}) {
  usePatientsData.mockReturnValue({
    patients: [], total: 0, stats: null, isLoading: false, error: null, refetch, ...over,
  });
}

/** Os filtros da última chamada do hook — é assim que a página fala com a API. */
function ultimosFiltros() {
  return usePatientsData.mock.calls[usePatientsData.mock.calls.length - 1][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  comDados();
});
afterEach(() => { vi.useRealTimers(); });

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

// ── Estados da tela ───────────────────────────────────────────────────────────

describe('AdminPatientsPage — os três estados', () => {
  it('carregando: skeleton, sem tabela', () => {
    comDados({ isLoading: true });
    render(<AdminPatientsPage />);
    expect(screen.getByTestId('skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('tabela')).toBeNull();
  });

  it('erro: mensagem + o texto do erro, e a tabela NÃO aparece', () => {
    comDados({ error: 'API caiu', isLoading: true });
    render(<AdminPatientsPage />);
    expect(screen.getByText('admin.patients.errorLoading')).toBeInTheDocument();
    expect(screen.getByText('API caiu')).toBeInTheDocument();
    expect(screen.queryByTestId('skeleton')).toBeNull();
  });

  it('carregado: tabela', () => {
    render(<AdminPatientsPage />);
    expect(screen.getByTestId('tabela')).toBeInTheDocument();
  });
});

// ── Mapeamento do payload ─────────────────────────────────────────────────────

describe('AdminPatientsPage — o que chega da API vira linha', () => {
  it('payload completo passa inteiro', () => {
    comDados({ patients: [{ id: 'x', firstName: 'A', lastName: 'B', responsibleName: 'R', documentType: 'DNI', documentNumber: '1', caseNumber: 9, dependencyLevel: 'MILD', clinicalSpecialty: 'ASD', serviceType: ['AT'], needsAttention: true, attentionReasons: ['MISSING_INFO'], createdAt: '2026-01-01T00:00:00Z' }] });
    render(<AdminPatientsPage />);
    const linha = JSON.parse(screen.getByTestId('tabela').dataset.json!)[0];
    expect(linha).toMatchObject({ id: 'x', firstName: 'A', responsibleName: 'R', caseNumber: 9, createdAt: '2026-01-01T00:00:00Z', serviceType: ['AT'] });
  });

  it('payload VAZIO cai nos defaults — nenhum undefined vaza para a tabela', () => {
    comDados({ patients: [{ id: 'y' }] });
    render(<AdminPatientsPage />);
    const linha = JSON.parse(screen.getByTestId('tabela').dataset.json!)[0];
    expect(linha).toEqual({
      id: 'y', firstName: '', lastName: '', responsibleName: null, documentType: null,
      documentNumber: null, caseNumber: null, dependencyLevel: null, clinicalSpecialty: null,
      serviceType: [], needsAttention: false, attentionReasons: [], createdAt: null,
    });
  });

  it('`patients` nulo não quebra a página', () => {
    comDados({ patients: null });
    render(<AdminPatientsPage />);
    expect(JSON.parse(screen.getByTestId('tabela').dataset.json!)).toEqual([]);
  });

  it('clique na linha navega para o detalhe', async () => {
    comDados({ patients: [{ id: 'abc' }] });
    render(<AdminPatientsPage />);
    await user().click(screen.getByTestId('linha'));
    expect(navigate).toHaveBeenCalledWith('/admin/patients/abc');
  });
});

// ── Filtros → parâmetros da API ───────────────────────────────────────────────

describe('AdminPatientsPage — filtro vira parâmetro', () => {
  it('sem filtro nenhum: só limit e offset', () => {
    render(<AdminPatientsPage />);
    expect(ultimosFiltros()).toEqual({
      search: undefined, needs_attention: undefined, attention_reason: undefined,
      clinical_specialty: undefined, dependency_level: undefined, case_number: undefined,
      country: undefined, limit: '20', offset: '0',
    });
  });

  it('busca só chega à API DEPOIS do debounce de 400ms', async () => {
    render(<AdminPatientsPage />);
    await user().type(screen.getByTestId('f-busca'), 'ana');
    expect(ultimosFiltros().search).toBeUndefined();
    act(() => { vi.advanceTimersByTime(400); });
    expect(ultimosFiltros().search).toBe('ana');
  });

  it('código também é debounced', async () => {
    render(<AdminPatientsPage />);
    await user().type(screen.getByTestId('f-codigo'), '42');
    expect(ultimosFiltros().case_number).toBeUndefined();
    act(() => { vi.advanceTimersByTime(400); });
    expect(ultimosFiltros().case_number).toBe('42');
  });

  it('trocar "atención" LIMPA o motivo — senão a API recebe motivo de um estado que não existe mais', async () => {
    render(<AdminPatientsPage />);
    const u = user();
    await u.click(screen.getByTestId('f-atencion'));
    await u.click(screen.getByTestId('f-motivo'));
    expect(ultimosFiltros().attention_reason).toBe('MISSING_INFO');
    await u.click(screen.getByTestId('f-completo'));
    expect(screen.getByTestId('f-motivo-atual').textContent).toBe('');
    expect(ultimosFiltros().attention_reason).toBeUndefined();
    expect(ultimosFiltros().needs_attention).toBe('false');
  });

  it('motivo só vai junto quando o estado é "needs_attention"', async () => {
    render(<AdminPatientsPage />);
    await user().click(screen.getByTestId('f-motivo'));
    expect(ultimosFiltros().attention_reason).toBeUndefined();
  });

  it('especialidade, dependência e país viram parâmetro', async () => {
    render(<AdminPatientsPage />);
    const u = user();
    await u.click(screen.getByTestId('f-especialidad'));
    await u.click(screen.getByTestId('f-dependencia'));
    await u.click(screen.getByTestId('f-pais'));
    expect(ultimosFiltros()).toMatchObject({ clinical_specialty: 'ASD', dependency_level: 'SEVERE', country: 'AR' });
  });
});

// ── Paginação ─────────────────────────────────────────────────────────────────

describe('AdminPatientsPage — paginação', () => {
  it('lista vazia: contador zerado e as duas setas desabilitadas', () => {
    comDados({ total: 0 });
    render(<AdminPatientsPage />);
    expect(screen.getByText('admin.patients.pagination:0-0/0')).toBeInTheDocument();
    expect(screen.getByLabelText('admin.patients.previousPage')).toBeDisabled();
    expect(screen.getByLabelText('admin.patients.nextPage')).toBeDisabled();
  });

  it('avançar soma o offset; voltar desfaz', async () => {
    comDados({ total: 55 });
    render(<AdminPatientsPage />);
    const u = user();
    expect(screen.getByText('admin.patients.pagination:1-20/55')).toBeInTheDocument();

    await u.click(screen.getByLabelText('admin.patients.nextPage'));
    expect(ultimosFiltros().offset).toBe('20');
    expect(screen.getByText('admin.patients.pagination:21-40/55')).toBeInTheDocument();

    await u.click(screen.getByLabelText('admin.patients.previousPage'));
    expect(ultimosFiltros().offset).toBe('0');
  });

  it('a última página trunca o fim no total e desabilita "próxima"', async () => {
    comDados({ total: 25 });
    render(<AdminPatientsPage />);
    await user().click(screen.getByLabelText('admin.patients.nextPage'));
    expect(screen.getByText('admin.patients.pagination:21-25/25')).toBeInTheDocument();
    expect(screen.getByLabelText('admin.patients.nextPage')).toBeDisabled();
  });

  it('trocar itens por página VOLTA para a primeira', async () => {
    comDados({ total: 55 });
    render(<AdminPatientsPage />);
    const u = user();
    await u.click(screen.getByLabelText('admin.patients.nextPage'));
    expect(ultimosFiltros().offset).toBe('20');
    await u.click(screen.getByTestId('por-pagina'));
    expect(ultimosFiltros()).toMatchObject({ limit: '10', offset: '0' });
  });
});

// ── Ações do cabeçalho ────────────────────────────────────────────────────────

describe('AdminPatientsPage — ações', () => {
  it('kanban navega', async () => {
    render(<AdminPatientsPage />);
    await user().click(screen.getByTestId('patients-kanban-link'));
    expect(navigate).toHaveBeenCalledWith('/admin/patients/kanban');
  });

  // Atualizado no rebase da branch de admissão: o `main` (#290) escreveu este teste quando criar
  // paciente RECARREGAVA a lista. O bloco D (spec 014, item D5) mudou o comportamento de propósito
  // — criar paciente CAI NA FICHA, e o e2e `admission-d-ux` item 4 prova isso ponta a ponta.
  // Recarregar a lista deixou de ser o efeito; navegar é.
  it('modal abre, fecha, e ao criar navega para a ficha do paciente criado', async () => {
    comDados({ total: 55 });
    render(<AdminPatientsPage />);
    const u = user();
    expect(screen.queryByTestId('modal')).toBeNull();

    await u.click(screen.getByTestId('new-patient-btn'));
    expect(screen.getByTestId('modal')).toBeInTheDocument();
    await u.click(screen.getByTestId('modal-fechar'));
    expect(screen.queryByTestId('modal')).toBeNull();

    await u.click(screen.getByLabelText('admin.patients.nextPage'));
    await u.click(screen.getByTestId('new-patient-btn'));
    await u.click(screen.getByTestId('modal-criado'));
    expect(navigate).toHaveBeenCalledWith('/admin/patients/novo-123');
  });

  it('desmontar limpa os debounces pendentes — sem setState em componente morto', async () => {
    const { unmount } = render(<AdminPatientsPage />);
    await user().type(screen.getByTestId('f-busca'), 'x');
    const chamadas = usePatientsData.mock.calls.length;
    unmount();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(usePatientsData.mock.calls.length).toBe(chamadas);
  });
});
