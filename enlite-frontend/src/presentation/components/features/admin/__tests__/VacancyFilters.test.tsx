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

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VacancyFilters, type VacancyAdvancedFilters } from '../VacancyFilters';
import type { ComboboxOption } from '@presentation/components/atoms/Combobox';
import { selectCombo, comboLabels } from '@presentation/components/atoms/Combobox/testUtils';


vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const STATUS_OPTIONS: ComboboxOption[] = [
  { value: 'SEARCHING',             label: 'Buscando AT' },
  { value: 'SEARCHING_REPLACEMENT', label: 'Buscando Sustituto' },
  { value: 'RAPID_RESPONSE',        label: 'Respuesta Rápida' },
  { value: 'PENDING_ACTIVATION',    label: 'Esperando Activación' },
  { value: 'ACTIVE',                label: 'Activo' },
  { value: 'ON_HOLD',               label: 'En Espera' },
  { value: 'SUSPENDED',             label: 'Suspendido' },
  { value: 'CLOSED',                label: 'Cerrado' },
];

const INITIAL_ADVANCED: VacancyAdvancedFilters = {
  workerType: '',
  state: '',
  city: '',
  requiredSex: '',
  days: [],
  timeFrom: '',
  timeTo: '',
};

function defaultProps(overrides: Partial<Parameters<typeof VacancyFilters>[0]> = {}) {
  return {
    searchQuery: '',
    onSearchChange: vi.fn(),
    selectedStatus: '',
    onStatusChange: vi.fn(),
    statusOptions: STATUS_OPTIONS,
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

  it('exibe o label de Status', () => {
    render(<VacancyFilters {...defaultProps()} />);
    expect(screen.getByText('admin.vacancies.statusLabel')).toBeInTheDocument();
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
    render(<VacancyFilters {...defaultProps({ selectedStatus: 'ACTIVE' })} />);
    expect(screen.getByText('admin.vacancies.filters.clear')).toBeInTheDocument();
  });
});

// ── Opções dos selects ────────────────────────────────────────────────────────

describe('VacancyFilters — opções', () => {
  it('select de status renderiza os 8 valores canônicos do banco', () => {
    render(<VacancyFilters {...defaultProps()} />);
    // o painel só existe aberto: abre o gatilho do Status (o 1º combobox) e lê as linhas
    expect(comboLabels(screen.getAllByRole('combobox')[0])).toEqual([
      'Buscando AT',
      'Buscando Sustituto',
      'Respuesta Rápida',
      'Esperando Activación',
      'Activo',
      'En Espera',
      'Suspendido',
      'Cerrado',
    ]);
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
  it('onStatusChange é chamado com o valor canônico ao selecionar um status', async () => {
    const onStatusChange = vi.fn();
    render(<VacancyFilters {...defaultProps({ onStatusChange })} />);

    const selects = screen.getAllByRole('combobox');
    await selectCombo(selects[0], 'Activo'); // ACTIVE = Activo

    expect(onStatusChange).toHaveBeenCalledWith('ACTIVE');
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

    // Tipo é o 2º combobox (0=status, 1=type)
    const selects = screen.getAllByRole('combobox');
    await selectCombo(selects[1], 'admin.vacancies.filters.type.at'); // AT (o mock de i18n devolve a chave)

    expect(onAdvancedChange).toHaveBeenCalledWith({ workerType: 'AT' });
  });

  it('onAdvancedChange é chamado ao selecionar Sexo', async () => {
    const onAdvancedChange = vi.fn();
    render(<VacancyFilters {...defaultProps({ onAdvancedChange })} />);

    // Ordem dos combobox: status(0), type(1), província(2), localidade(3), sex(4), dias(5).
    const selects = screen.getAllByRole('combobox');
    await selectCombo(selects[4], 'admin.vacancies.filters.sex.f'); // F

    expect(onAdvancedChange).toHaveBeenCalledWith({ requiredSex: 'F' });
  });

  it('botão Limpiar chama todos os handlers para reset', () => {
    const onSearchChange = vi.fn();
    const onStatusChange = vi.fn();
    const onAdvancedChange = vi.fn();

    render(
      <VacancyFilters
        {...defaultProps({ onSearchChange, onStatusChange, onAdvancedChange })}
        selectedStatus="ACTIVE"
      />,
    );

    fireEvent.click(screen.getByText('admin.vacancies.filters.clear'));

    expect(onSearchChange).toHaveBeenCalledWith('');
    expect(onStatusChange).toHaveBeenCalledWith('');
    expect(onAdvancedChange).toHaveBeenCalledWith({
      workerType: '',
      state: '',
      city: '',
      requiredSex: '',
      days: [],
      timeFrom: '',
      timeTo: '',
    });
  });
});

// ── Estado refletido ──────────────────────────────────────────────────────────

describe('VacancyFilters — estado refletido nos selects', () => {
  it('selectedStatus="ON_HOLD" é refletido no select de status', () => {
    render(<VacancyFilters {...defaultProps({ selectedStatus: 'ON_HOLD' })} />);
    const selects = screen.getAllByRole('combobox');
    expect(selects[0]).toHaveTextContent('En Espera'); // ON_HOLD = En Espera
  });

  it('advancedFilters.workerType="AT" é refletido no select de Tipo', () => {
    render(
      <VacancyFilters
        {...defaultProps({ advancedFilters: { ...INITIAL_ADVANCED, workerType: 'AT' } })}
      />,
    );
    const selects = screen.getAllByRole('combobox');
    expect(selects[1]).toHaveTextContent('admin.vacancies.filters.type.at'); // AT
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
