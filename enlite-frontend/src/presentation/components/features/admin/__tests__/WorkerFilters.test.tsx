/**
 * WorkerFilters.test.tsx — checkbox "Mostrar desactivados" (D-2026-09-28).
 *
 * Cobertura mínima e focada: o componente inteiro não tinha teste antes (gap
 * pré-existente, fora de escopo consertar aqui) — este arquivo nasce cobrindo
 * só a peça nova que este PR adiciona (o mesmo padrão de `WorkersTable.test.tsx`:
 * i18n mockado como identidade, sem depender de tradução real).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WorkerFilters } from '../WorkerFilters';
import { INITIAL_PROFILE_FILTERS } from '../workerProfileFiltersConfig';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

function montar(over: Partial<React.ComponentProps<typeof WorkerFilters>> = {}) {
  const props: React.ComponentProps<typeof WorkerFilters> = {
    searchValue: '', onSearchChange: vi.fn(),
    selectedDocsStatus: '', onDocsStatusChange: vi.fn(), docsStatusOptions: [],
    selectedValidationStatus: '', onValidationStatusChange: vi.fn(), validationStatusOptions: [],
    caseOptions: [], selectedCaseId: '', onCaseChange: vi.fn(),
    tagOptions: [], selectedTagIds: [], onTagIdsChange: vi.fn(),
    profileFilters: INITIAL_PROFILE_FILTERS, onProfileFiltersChange: vi.fn(),
    stateOptions: [], cityOptions: [], experienceTypeOptions: [], preferredTypeOptions: [],
    showDeactivated: false, onShowDeactivatedChange: vi.fn(),
    ...over,
  };
  render(<WorkerFilters {...props} />);
  return props;
}

describe('WorkerFilters — checkbox "Mostrar desactivados" (D-2026-09-28)', () => {
  it('renderiza desmarcado por padrão e dispara onShowDeactivatedChange(true) ao clicar', () => {
    const props = montar();
    const wrapper = screen.getByTestId('filter-show-deactivated');
    const input = wrapper.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.checked).toBe(false);

    fireEvent.click(input);
    expect(props.onShowDeactivatedChange).toHaveBeenCalledWith(true);
  });

  it('showDeactivated=true renderiza marcado e conta como filtro ativo ("limpar" aparece, mesmo sem mais nada selecionado)', () => {
    montar({ showDeactivated: true });
    const input = screen.getByTestId('filter-show-deactivated').querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(input.checked).toBe(true);
    expect(screen.getByText('admin.workers.clearFilters')).toBeInTheDocument();
  });

  it('"limpar" com showDeactivated=true também chama onShowDeactivatedChange(false)', () => {
    const props = montar({ showDeactivated: true });
    fireEvent.click(screen.getByText('admin.workers.clearFilters'));
    expect(props.onShowDeactivatedChange).toHaveBeenCalledWith(false);
  });

  it('sem nenhum filtro ativo (showDeactivated=false e resto vazio): botão "limpar" não aparece', () => {
    montar();
    expect(screen.queryByText('admin.workers.clearFilters')).toBeNull();
  });
});
