/**
 * PatientKanbanPage — semaforo-da-vaga F3: filtro multi por cor, no cliente, sobre `worstSemaphore`. Só existe com o agregado ok.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { chooseCombo, comboLabels } from '@presentation/components/atoms/Combobox/testUtils';
import type { PatientKanbanItem } from '@domain/entities/PatientDetail';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => (typeof opts === 'object' && opts?.defaultValue ? opts.defaultValue : key) }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

const p = (id: string, worstSemaphore: PatientKanbanItem['worstSemaphore']): PatientKanbanItem => ({
  id, firstName: 'P', lastName: id, caseNumber: null, dependencyLevel: null, status: 'ACTIVE', admissionStatus: 'DONE', responsibleName: null, worstSemaphore,
});
const kanban: { groups: Record<string, PatientKanbanItem[]>; isLoading: boolean; error: null; servicesStatus: 'ok' | 'forbidden' | 'error' } = {
  groups: {}, isLoading: false, error: null, servicesStatus: 'ok',
};
vi.mock('@hooks/admin/usePatientKanban', () => ({ usePatientKanban: () => kanban }));
vi.mock('@presentation/components/features/admin/PatientDetail/kanban/PatientKanbanBoard', () => ({
  PatientKanbanBoard: ({ groups }: { groups: Record<string, PatientKanbanItem[]> }) => (
    <div data-testid="board-stub">{Object.values(groups).flat().map((i) => i.id).join(',')}</div>
  ),
}));

import { PatientKanbanPage } from '../PatientKanbanPage';

beforeEach(() => {
  kanban.servicesStatus = 'ok';
  kanban.groups = { ADMISSION: [p('a', 'red')], ACTIVE: [p('b', 'green'), p('c', 'yellow'), p('d', null)] };
});

const trigger = () => screen.getByTestId('patient-semaphore-filter').querySelector('[role="combobox"]') as HTMLElement;

describe('PatientKanbanPage — filtro por cor (semaforo-da-vaga F3)', () => {
  it('sem seleção o board recebe todos os pacientes', () => {
    render(<PatientKanbanPage />);
    expect(screen.getByTestId('board-stub')).toHaveTextContent('a,b,c,d');
  });

  it('escolher "Rojo" deixa só o paciente de worstSemaphore red; somar "Verde" soma o verde (multi)', () => {
    render(<PatientKanbanPage />);
    chooseCombo(trigger(), 'admin.semaphore.colors.red');
    expect(screen.getByTestId('board-stub').textContent).toBe('a');
    chooseCombo(trigger(), 'admin.semaphore.colors.green');
    expect(screen.getByTestId('board-stub').textContent).toBe('a,b');
  });

  it('o filtro oferece só as 3 cores (sem opção "sin semáforo")', () => {
    render(<PatientKanbanPage />);
    expect(comboLabels(trigger())).toEqual(['admin.semaphore.colors.red', 'admin.semaphore.colors.yellow', 'admin.semaphore.colors.green']);
  });

  it.each(['forbidden', 'error'] as const)('agregado %s → o filtro não aparece e nada é filtrado', (status) => {
    kanban.servicesStatus = status;
    render(<PatientKanbanPage />);
    expect(screen.queryByTestId('patient-semaphore-filter')).not.toBeInTheDocument();
    expect(screen.getByTestId('board-stub')).toHaveTextContent('a,b,c,d');
  });
});
