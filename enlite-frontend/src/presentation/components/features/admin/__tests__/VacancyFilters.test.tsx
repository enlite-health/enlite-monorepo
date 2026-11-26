/**
 * VacancyFilters.test.tsx
 *
 * Testa o componente de filtros da página de vagas:
 * - Renderização dos selects (status, prioridade, tipo, sexo, provincia, localidade)
 * - Callbacks disparados ao alterar cada filtro
 * - Combobox (multiple) para dias
 * - TimeRangeFilter para horário
 * - Botão Limpiar filtros
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VacancyFilters, type VacancyAdvancedFilters } from '../VacancyFilters';
import type { ComboboxOption } from '@presentation/components/atoms/Combobox';
import { selectCombo, comboLabels } from '@presentation/components/atoms/Combobox/testUtils';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';


vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const LIFECYCLE_OPTIONS: ComboboxOption[] = [
  { value: 'rascunho', label: 'Borrador' },
  { value: 'aberta', label: 'Abierta' },
  { value: 'pausada', label: 'En espera' },
  { value: 'cerrada', label: 'Cerrada' },
  { value: 'baja', label: 'Dada de baja' },
];

const PATIENT_STATUS_OPTIONS: ComboboxOption[] = [
  { value: 'SEARCHING', label: 'Búsqueda' },
  { value: 'REPLACEMENT', label: 'Reemplazos' },
  { value: 'ACTIVE', label: 'Activo' },
];

const INITIAL_ADVANCED: VacancyAdvancedFilters = {
  workerType: '',
  state: '',
  city: '',
  requiredSex: '',
  days: [],
  semaphore: [],
  timeFrom: '',
  timeTo: '',
};

const SEMAPHORE_OPTIONS: ComboboxOption[] = [
  { value: 'red', label: 'Rojo' },
  { value: 'yellow', label: 'Amarillo' },
  { value: 'green', label: 'Verde' },
];

function defaultProps(overrides: Partial<Parameters<typeof VacancyFilters>[0]> = {}) {
  return {
    searchQuery: '',
    onSearchChange: vi.fn(),
    selectedLifecycle: '',
    onLifecycleChange: vi.fn(),
    lifecycleOptions: LIFECYCLE_OPTIONS,
    selectedPatientStatus: '',
    onPatientStatusChange: vi.fn(),
    patientStatusOptions: PATIENT_STATUS_OPTIONS,
    semaphoreOptions: SEMAPHORE_OPTIONS,
    advancedFilters: INITIAL_ADVANCED,
    onAdvancedChange: vi.fn(),
    stateOptions: [],
    cityOptions: [],
    ...overrides,
  };
}

// ── Renderização ──────────────────────────────────────────────────────────────

describe('VacancyFilters — renderização', () => {
  it('exibe o campo de busca', () => {
    render(<VacancyFilters {...defaultProps()} />);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('exibe os labels dos DOIS filtros de estado (E7): Ciclo de vida e Estado del paciente', () => {
    render(<VacancyFilters {...defaultProps()} />);
    expect(screen.getByText('admin.vacancies.filters.lifecycle.label')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.filters.patientStatus.label')).toBeInTheDocument();
    expect(screen.queryByText('admin.vacancies.statusLabel')).not.toBeInTheDocument(); // o "Estado" de valores do banco saiu
  });

  it('A4 (spec 046 F1): NÃO exibe filtro de Prioridad', () => {
    render(<VacancyFilters {...defaultProps()} />);
    expect(screen.queryByText('admin.vacancies.priorityLabel')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.vacancies.priorityOptions.all')).not.toBeInTheDocument();
  });

  it('NÃO renderiza o filtro de Clientes (removido)', () => {
    render(<VacancyFilters {...defaultProps()} />);
    expect(screen.queryByText('admin.vacancies.clients')).not.toBeInTheDocument();
  });

  it('exibe labels dos 6 filtros avançados', () => {
    render(<VacancyFilters {...defaultProps()} />);
    expect(screen.getByText('admin.vacancies.filters.type.label')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.filters.province.label')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.filters.locality.label')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.filters.sex.label')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.filters.days.label')).toBeInTheDocument();
    expect(screen.getByText('admin.vacancies.filters.time.label')).toBeInTheDocument();
  });

  it('não exibe botão Limpiar quando não há filtros ativos', () => {
    render(<VacancyFilters {...defaultProps()} />);
    expect(screen.queryByText('admin.vacancies.filters.clear')).not.toBeInTheDocument();
  });

  it('exibe botão Limpiar quando há filtro ativo', () => {
    render(<VacancyFilters {...defaultProps({ selectedLifecycle: 'aberta' })} />);
    expect(screen.getByText('admin.vacancies.filters.clear')).toBeInTheDocument();
  });
});

// ── Opções dos selects ────────────────────────────────────────────────────────

describe('VacancyFilters — opções', () => {
  it('Ciclo de vida oferece os 5 valores do dono; nenhum valor de banco legado (E7)', () => {
    render(<VacancyFilters {...defaultProps()} />);
    // o painel só existe aberto: abre o gatilho do Ciclo de vida (o 1º combobox) e lê as linhas
    expect(comboLabels(screen.getAllByRole('combobox')[0])).toEqual(['Borrador', 'Abierta', 'En espera', 'Cerrada', 'Dada de baja']);
  });

  it('Estado del paciente é o 2º combobox e oferece o que a tela recebeu', () => {
    render(<VacancyFilters {...defaultProps()} />);
    expect(comboLabels(screen.getAllByRole('combobox')[1])).toEqual(['Búsqueda', 'Reemplazos', 'Activo']);
  });

  it('Provincia é um combobox com busca e popula com stateOptions recebidas (REQ-06)', async () => {
    // 3+ opções: é a regra do Combobox para existir o campo de busca (SEARCH_MIN_OPTIONS)
    const stateOptions = [{ value: 'BA', label: 'Buenos Aires' }, { value: 'CB', label: 'Córdoba' }, { value: 'MZ', label: 'Mendoza' }];
    render(<VacancyFilters {...defaultProps({ stateOptions })} />);
    await userEvent.click(screen.getByTestId('vacancy-filter-province'));
    expect(screen.getByRole('option', { name: 'Buenos Aires' })).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText('common.search'), 'cor'); // i18n mock devolve a chave
    expect(screen.queryByRole('option', { name: 'Buenos Aires' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Córdoba' })).toBeInTheDocument();
  });

  it('Localidad é um combobox com busca e popula com cityOptions recebidas (REQ-06)', async () => {
    const cityOptions = [{ value: 'Palermo', label: 'Palermo' }];
    render(<VacancyFilters {...defaultProps({ cityOptions })} />);
    await userEvent.click(screen.getByTestId('vacancy-filter-locality'));
    expect(screen.getByRole('option', { name: 'Palermo' })).toBeInTheDocument();
  });

  it('escolher uma Provincia no combobox chama onAdvancedChange({ state })', async () => {
    const onAdvancedChange = vi.fn();
    const stateOptions = [{ value: 'BA', label: 'Buenos Aires' }];
    render(<VacancyFilters {...defaultProps({ stateOptions, onAdvancedChange })} />);
    await selectCombo(screen.getByTestId('vacancy-filter-province'), 'Buenos Aires');
    expect(onAdvancedChange).toHaveBeenCalledWith({ state: 'BA' });
  });
});

// ── Callbacks ─────────────────────────────────────────────────────────────────

describe('VacancyFilters — callbacks', () => {
  it('onLifecycleChange é chamado com o valor do ciclo ao selecionar', async () => {
    const onLifecycleChange = vi.fn();
    render(<VacancyFilters {...defaultProps({ onLifecycleChange })} />);
    await selectCombo(screen.getAllByRole('combobox')[0], 'En espera');
    expect(onLifecycleChange).toHaveBeenCalledWith('pausada');
  });

  it('onPatientStatusChange é chamado com o estado do paciente ao selecionar', async () => {
    const onPatientStatusChange = vi.fn();
    render(<VacancyFilters {...defaultProps({ onPatientStatusChange })} />);
    await selectCombo(screen.getAllByRole('combobox')[1], 'Reemplazos');
    expect(onPatientStatusChange).toHaveBeenCalledWith('REPLACEMENT');
  });

  it('onSearchChange é chamado ao digitar na busca', async () => {
    const onSearchChange = vi.fn();
    render(<VacancyFilters {...defaultProps({ onSearchChange })} />);

    await userEvent.type(screen.getByRole('textbox'), 'Ana');

    expect(onSearchChange).toHaveBeenCalled();
  });

  it('onAdvancedChange é chamado ao selecionar Tipo', async () => {
    const onAdvancedChange = vi.fn();
    render(<VacancyFilters {...defaultProps({ onAdvancedChange })} />);

    // Tipo é o 3º combobox (0=ciclo de vida, 1=estado do paciente, 2=type)
    const selects = screen.getAllByRole('combobox');
    await selectCombo(selects[2], 'admin.vacancies.filters.type.at'); // AT (o mock de i18n devolve a chave)

    expect(onAdvancedChange).toHaveBeenCalledWith({ workerType: 'AT' });
  });

  it('onAdvancedChange é chamado ao selecionar Sexo', async () => {
    const onAdvancedChange = vi.fn();
    render(<VacancyFilters {...defaultProps({ onAdvancedChange })} />);

    // Ordem dos combobox: ciclo(0), estado do paciente(1), type(2), província(3), localidade(4), sex(5), dias(6).
    const selects = screen.getAllByRole('combobox');
    await selectCombo(selects[5], 'admin.vacancies.filters.sex.f'); // F

    expect(onAdvancedChange).toHaveBeenCalledWith({ requiredSex: 'F' });
  });

  it('botão Limpiar chama todos os handlers para reset', () => {
    const onSearchChange = vi.fn();
    const onLifecycleChange = vi.fn();
    const onPatientStatusChange = vi.fn();
    const onAdvancedChange = vi.fn();

    render(
      <VacancyFilters
        {...defaultProps({ onSearchChange, onLifecycleChange, onPatientStatusChange, onAdvancedChange })}
        selectedLifecycle="aberta"
        selectedPatientStatus="SEARCHING"
      />,
    );

    fireEvent.click(screen.getByText('admin.vacancies.filters.clear'));

    expect(onSearchChange).toHaveBeenCalledWith('');
    expect(onLifecycleChange).toHaveBeenCalledWith('');
    expect(onPatientStatusChange).toHaveBeenCalledWith('');
    expect(onAdvancedChange).toHaveBeenCalledWith({
      workerType: '',
      state: '',
      city: '',
      requiredSex: '',
      days: [],
      semaphore: [],
      timeFrom: '',
      timeTo: '',
    });
  });
});

// ── Estado refletido ──────────────────────────────────────────────────────────

describe('VacancyFilters — estado refletido nos selects', () => {
  it('selectedLifecycle="pausada" é refletido no select de Ciclo de vida', () => {
    render(<VacancyFilters {...defaultProps({ selectedLifecycle: 'pausada' })} />);
    expect(screen.getAllByRole('combobox')[0]).toHaveTextContent('En espera');
  });

  it('selectedPatientStatus="REPLACEMENT" é refletido no select de Estado del paciente', () => {
    render(<VacancyFilters {...defaultProps({ selectedPatientStatus: 'REPLACEMENT' })} />);
    expect(screen.getAllByRole('combobox')[1]).toHaveTextContent('Reemplazos');
  });

  it('advancedFilters.workerType="AT" é refletido no select de Tipo', () => {
    render(
      <VacancyFilters
        {...defaultProps({ advancedFilters: { ...INITIAL_ADVANCED, workerType: 'AT' } })}
      />,
    );
    const selects = screen.getAllByRole('combobox');
    expect(selects[2]).toHaveTextContent('admin.vacancies.filters.type.at'); // AT
  });

  it('advancedFilters.days com valores mostra count no Combobox', () => {
    render(
      <VacancyFilters
        {...defaultProps({ advancedFilters: { ...INITIAL_ADVANCED, days: ['1', '3'] } })}
      />,
    );
    // With 2 days selected, the Combobox button should show the count key
    expect(screen.getByText('common.multiSelect.selectedCount')).toBeInTheDocument();
  });
});


// ── semaforo-da-vaga F3: filtro multi por cor ─────────────────────────────────────────────────────────────
describe('VacancyFilters — filtro "Semáforo" (multi, 3 cores)', () => {
  it('mostra o rótulo e as 3 cores, e a linha 1 continua com os mesmos comboboxes (os e2e leem por índice)', () => {
    render(<VacancyFilters {...defaultProps()} />);
    expect(screen.getByText('admin.semaphore.filterLabel')).toBeInTheDocument();
    expect(comboLabels(screen.getByTestId('vacancy-filter-semaphore'))).toEqual(['Rojo', 'Amarillo', 'Verde']);
    expect(comboLabels(screen.getAllByRole('combobox')[0])).toEqual(['Borrador', 'Abierta', 'En espera', 'Cerrada', 'Dada de baja']);
  });

  it('escolher uma cor manda { semaphore: [cor] } ao onAdvancedChange', async () => {
    const onAdvancedChange = vi.fn();
    render(<VacancyFilters {...defaultProps({ onAdvancedChange })} />);
    await selectCombo(screen.getByTestId('vacancy-filter-semaphore'), 'Verde');
    expect(onAdvancedChange).toHaveBeenCalledWith({ semaphore: ['green'] });
  });

  it('só o semáforo ativo já mostra "Limpiar filtros"', () => {
    render(<VacancyFilters {...defaultProps({ advancedFilters: { ...INITIAL_ADVANCED, semaphore: ['red'] } })} />);
    expect(screen.getByText('admin.vacancies.filters.clear')).toBeInTheDocument();
  });
});

// ── E7: o filtro por estado do paciente segue o container `patient` ────────────────────────────────────────
describe('VacancyFilters — "Estado del paciente" só existe para quem lê o container `patient` (lex P5)', () => {
  const comEnforcement = (permissions: string[]) =>
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement: 'on' } as AuthzContract,
    });
  afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('sem patient:read (enforcement on) o filtro SOME; o de ciclo de vida continua', () => {
    comEnforcement(['vacancy:read']);
    render(<VacancyFilters {...defaultProps()} />);
    expect(screen.queryByTestId('vacancy-filter-patient-status')).not.toBeInTheDocument();
    expect(screen.getByTestId('vacancy-filter-lifecycle')).toBeInTheDocument();
  });

  it('com patient:read o filtro aparece', () => {
    comEnforcement(['vacancy:read', 'patient:read']);
    render(<VacancyFilters {...defaultProps()} />);
    expect(screen.getByTestId('vacancy-filter-patient-status')).toBeInTheDocument();
  });
});
