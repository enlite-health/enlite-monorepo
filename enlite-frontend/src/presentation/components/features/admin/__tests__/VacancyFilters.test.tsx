/**
 * VacancyFilters.test.tsx
 *
 * Testa o componente de filtros da página de vagas:
 * - Renderização dos selects (status, prioridade, tipo, sexo, provincia, localidade)
 * - Callbacks disparados ao alterar cada filtro
 * - MultiSelect para dias
 * - TimeRangeFilter para horário
 * - Botão Limpiar filtros
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VacancyFilters, type VacancyAdvancedFilters } from '../VacancyFilters';
import { SelectOption } from '@presentation/components/atoms/Select';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const STATUS_OPTIONS: SelectOption[] = [
  { value: 'SEARCHING',             label: 'Buscando AT' },
  { value: 'SEARCHING_REPLACEMENT', label: 'Buscando Sustituto' },
  { value: 'RAPID_RESPONSE',        label: 'Respuesta Rápida' },
  { value: 'PENDING_ACTIVATION',    label: 'Esperando Activación' },
  { value: 'ACTIVE',                label: 'Activo' },
  { value: 'ON_HOLD',               label: 'En Espera' },
  { value: 'SUSPENDED',             label: 'Suspendido' },
  { value: 'CLOSED',                label: 'Cerrado' },
];

const PRIORITY_OPTIONS: SelectOption[] = [
  { value: 'URGENT', label: 'Urgente' },
  { value: 'HIGH',   label: 'Alta' },
  { value: 'NORMAL', label: 'Normal' },
  { value: 'LOW',    label: 'Baja' },
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
    selectedPriority: '',
    onPriorityChange: vi.fn(),
    statusOptions: STATUS_OPTIONS,
    priorityOptions: PRIORITY_OPTIONS,
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

  it('exibe o label de Prioridade', () => {
    render(<VacancyFilters {...defaultProps()} />);
    expect(screen.getByText('admin.vacancies.priorityLabel')).toBeInTheDocument();
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
    expect(screen.getByText('Buscando AT')).toBeInTheDocument();
    expect(screen.getByText('Buscando Sustituto')).toBeInTheDocument();
    expect(screen.getByText('Respuesta Rápida')).toBeInTheDocument();
    expect(screen.getByText('Esperando Activación')).toBeInTheDocument();
    expect(screen.getByText('Activo')).toBeInTheDocument();
    expect(screen.getByText('En Espera')).toBeInTheDocument();
    expect(screen.getByText('Suspendido')).toBeInTheDocument();
    expect(screen.getByText('Cerrado')).toBeInTheDocument();
  });

  it('select de prioridade renderiza as 4 opções canônicas', () => {
    render(<VacancyFilters {...defaultProps()} />);
    expect(screen.getByText('Urgente')).toBeInTheDocument();
    expect(screen.getByText('Alta')).toBeInTheDocument();
    expect(screen.getByText('Normal')).toBeInTheDocument();
    expect(screen.getByText('Baja')).toBeInTheDocument();
  });

  it('Provincia popula com stateOptions recebidas', () => {
    const stateOptions = [{ value: 'BA', label: 'Buenos Aires' }];
    render(<VacancyFilters {...defaultProps({ stateOptions })} />);
    expect(screen.getByText('Buenos Aires')).toBeInTheDocument();
  });

  it('Localidad popula com cityOptions recebidas', () => {
    const cityOptions = [{ value: 'Palermo', label: 'Palermo' }];
    render(<VacancyFilters {...defaultProps({ cityOptions })} />);
    expect(screen.getByText('Palermo')).toBeInTheDocument();
  });
});

// ── Callbacks ─────────────────────────────────────────────────────────────────

describe('VacancyFilters — callbacks', () => {
  it('onStatusChange é chamado com o valor canônico ao selecionar um status', async () => {
    const onStatusChange = vi.fn();
    render(<VacancyFilters {...defaultProps({ onStatusChange })} />);

    const selects = screen.getAllByRole('combobox');
    await userEvent.selectOptions(selects[0], 'ACTIVE');

    expect(onStatusChange).toHaveBeenCalledWith('ACTIVE');
  });

  it('onPriorityChange é chamado com o valor canônico ao selecionar uma prioridade', async () => {
    const onPriorityChange = vi.fn();
    render(<VacancyFilters {...defaultProps({ onPriorityChange })} />);

    const selects = screen.getAllByRole('combobox');
    await userEvent.selectOptions(selects[1], 'URGENT');

    expect(onPriorityChange).toHaveBeenCalledWith('URGENT');
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

    // Tipo is the 3rd select (0=status, 1=priority, 2=type)
    const selects = screen.getAllByRole('combobox');
    await userEvent.selectOptions(selects[2], 'AT');

    expect(onAdvancedChange).toHaveBeenCalledWith({ workerType: 'AT' });
  });

  it('onAdvancedChange é chamado ao selecionar Sexo', async () => {
    const onAdvancedChange = vi.fn();
    render(<VacancyFilters {...defaultProps({ onAdvancedChange })} />);

    // Sexo select: status(0), priority(1), type(2), province(3), locality(4), sex(5), timeFrom(6), timeTo(7)
    const selects = screen.getAllByRole('combobox');
    await userEvent.selectOptions(selects[5], 'F');

    expect(onAdvancedChange).toHaveBeenCalledWith({ requiredSex: 'F' });
  });

  it('botão Limpiar chama todos os handlers para reset', () => {
    const onSearchChange = vi.fn();
    const onStatusChange = vi.fn();
    const onPriorityChange = vi.fn();
    const onAdvancedChange = vi.fn();

    render(
      <VacancyFilters
        {...defaultProps({ onSearchChange, onStatusChange, onPriorityChange, onAdvancedChange })}
        selectedStatus="ACTIVE"
      />,
    );

    fireEvent.click(screen.getByText('admin.vacancies.filters.clear'));

    expect(onSearchChange).toHaveBeenCalledWith('');
    expect(onStatusChange).toHaveBeenCalledWith('');
    expect(onPriorityChange).toHaveBeenCalledWith('');
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
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects[0].value).toBe('ON_HOLD');
  });

  it('selectedPriority="HIGH" é refletido no select de prioridade', () => {
    render(<VacancyFilters {...defaultProps({ selectedPriority: 'HIGH' })} />);
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects[1].value).toBe('HIGH');
  });

  it('selectedPriority="" mostra a opção vazia selecionada', () => {
    render(<VacancyFilters {...defaultProps({ selectedPriority: '' })} />);
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects[1].value).toBe('');
  });

  it('advancedFilters.workerType="AT" é refletido no select de Tipo', () => {
    render(
      <VacancyFilters
        {...defaultProps({ advancedFilters: { ...INITIAL_ADVANCED, workerType: 'AT' } })}
      />,
    );
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects[2].value).toBe('AT');
  });

  it('advancedFilters.days com valores mostra count no MultiSelect', () => {
    render(
      <VacancyFilters
        {...defaultProps({ advancedFilters: { ...INITIAL_ADVANCED, days: ['1', '3'] } })}
      />,
    );
    // With 2 days selected, the MultiSelect button should show the count key
    expect(screen.getByText('common.multiSelect.selectedCount')).toBeInTheDocument();
  });
});
