/**
 * PatientFilters — lex 08/09 (oráculo por célula, LISTA da spec 017): a busca por nome/documento e os
 * filtros clínicos só são OFERECIDOS a quem tem a célula literal de leitura do dado — o servidor
 * recusa com 403 nomeando o campo, e a tela não oferece o que ele recusaria. O nº de caso é
 * operacional e continua. Sem engine (freio D268): tudo aparece.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import { PatientFilters } from '../PatientFilters';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']): void {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract,
  });
}

function montar(over: Partial<React.ComponentProps<typeof PatientFilters>> = {}) {
  const props = {
    searchValue: '', onSearchChange: vi.fn(),
    codeValue: '', onCodeChange: vi.fn(),
    selectedAttention: '', onAttentionChange: vi.fn(),
    selectedReason: '', onReasonChange: vi.fn(),
    selectedSpecialty: '', onSpecialtyChange: vi.fn(),
    selectedDependency: '', onDependencyChange: vi.fn(),
    attentionOptions: [], reasonOptions: [], specialtyOptions: [{ value: 'NEUROLOGICAL', label: 'Neuro' }], dependencyOptions: [{ value: 'MILD', label: 'Leve' }],
    ...over,
  };
  render(<PatientFilters {...props} />);
  return props;
}

describe('PatientFilters — oráculo por célula', () => {
  beforeEach(() => { useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }); });

  it('🔒 engine ON, só `patient:read`: busca, especialidade e dependência SOMEM; nº de caso e atenção continuam', () => {
    comEnforcement(['patient:read'], 'on');
    montar();
    expect(screen.queryByTestId('filter-search')).not.toBeInTheDocument();
    expect(screen.queryByTestId('filter-specialty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('filter-dependency')).not.toBeInTheDocument();
    expect(screen.getByTestId('filter-code')).toBeInTheDocument();
    expect(screen.getByTestId('filter-attention')).toBeInTheDocument();
  });

  it('engine ON, com `patient_identity:read` mas sem clínica: a busca volta, os clínicos não', () => {
    comEnforcement(['patient:read', 'patient_identity:read'], 'on');
    const props = montar();
    expect(screen.getByTestId('filter-search')).toBeInTheDocument();
    expect(screen.queryByTestId('filter-specialty')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('filter-search').querySelector('input') as HTMLInputElement, { target: { value: 'Ana' } });
    expect(props.onSearchChange).toHaveBeenCalledWith('Ana');
  });

  it('engine ON, com as duas células: tudo aparece; engine OFF (ou ausente): tudo aparece mesmo sem célula', () => {
    comEnforcement(['patient:read', 'patient_identity:read', 'patient_clinical:read'], 'on');
    const r1 = montar();
    expect(screen.getByTestId('filter-search')).toBeInTheDocument();
    expect(screen.getByTestId('filter-specialty')).toBeInTheDocument();
    expect(screen.getByTestId('filter-dependency')).toBeInTheDocument();
    void r1;
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    // um segundo render, sem engine
    comEnforcement([], 'off');
    montar();
    expect(screen.getAllByTestId('filter-search')).toHaveLength(2);
    expect(screen.getAllByTestId('filter-dependency')).toHaveLength(2);
  });

  it('filtro de motivo só com "needs_attention"; "limpar" aparece com filtro ativo e zera TODOS (inclusive país quando existe)', () => {
    const props = montar({ selectedAttention: 'needs_attention', reasonOptions: [{ value: 'X', label: 'X' }], selectedCountry: 'AR', onCountryChange: vi.fn(), countryOptions: [{ value: 'AR', label: 'AR' }] });
    expect(screen.getByTestId('filter-reason')).toBeInTheDocument();
    expect(screen.getByTestId('patient-country-filter')).toBeInTheDocument();
    fireEvent.click(screen.getByText('admin.patients.clearFilters'));
    for (const fn of [props.onSearchChange, props.onCodeChange, props.onAttentionChange, props.onReasonChange, props.onSpecialtyChange, props.onDependencyChange, props.onCountryChange]) {
      expect(fn).toHaveBeenCalledWith('');
    }
  });

  it('sem filtro ativo e sem país: nem "limpar", nem motivo, nem país; com só código ativo o "limpar" aparece e não chama onCountryChange', () => {
    montar();
    expect(screen.queryByText('admin.patients.clearFilters')).not.toBeInTheDocument();
    expect(screen.queryByTestId('filter-reason')).not.toBeInTheDocument();
    expect(screen.queryByTestId('patient-country-filter')).not.toBeInTheDocument();
    const props = montar({ codeValue: '12' });
    const codeInputs = screen.getAllByTestId('filter-code');
    fireEvent.change(codeInputs[codeInputs.length - 1].querySelector('input') as HTMLInputElement, { target: { value: '123' } });
    expect(props.onCodeChange).toHaveBeenCalledWith('123');
    fireEvent.click(screen.getByText('admin.patients.clearFilters'));
    expect(props.onCodeChange).toHaveBeenCalledWith('');
  });

  it('país: sem `selectedCountry` o select nasce vazio; escolher chama onCountryChange', () => {
    const props = montar({ onCountryChange: vi.fn(), countryOptions: [{ value: 'AR', label: 'AR' }, { value: 'BR', label: 'BR' }] });
    const select = screen.getByTestId('patient-country-filter').querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: 'BR' } });
    expect(props.onCountryChange).toHaveBeenCalledWith('BR');
  });
});
