/**
 * VacancyFilters.test.tsx
 *
 * Testa o componente de filtros da página de vagas:
 * - Renderização dos selects (status, prioridade) — o filtro de Clientes foi removido
 * - Callbacks disparados ao alterar cada filtro
 * - Opções alinhadas com os valores canônicos do banco
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VacancyFilters } from '../VacancyFilters';
import { SelectOption } from '@presentation/components/atoms/Select';

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

  it('renderiza apenas 2 selects (status, prioridade) — sem o de Clientes', () => {
    render(<VacancyFilters {...defaultProps()} />);
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
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

  it('selectedPriority="" mostra a opção "Todas" selecionada', () => {
    render(<VacancyFilters {...defaultProps({ selectedPriority: '' })} />);
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(selects[1].value).toBe('');
  });
});
