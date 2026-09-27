/**
 * PatientKanbanPage — P13 (DX-8.9): quando o agregado do subcard falha por um motivo QUE NÃO É
 * 403 (`servicesStatus === 'error'`), a página mostra uma linha de aviso — nunca silêncio (falha
 * calada faria o operador ler "sem serviço" onde há serviço). 403 (`'forbidden'`, o ator não lê
 * serviços) e `'ok'` não mostram nada. Molde: `PatientKanbanPage.moveError.test.tsx` (hook mockado).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const dict: Record<string, string> = {
        'admin.patients.kanban.subcard.loadError': 'No se pudieron cargar los servicios de los pacientes.',
      };
      return dict[key] ?? key;
    },
  }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

const showToast = vi.fn();
vi.mock('@presentation/hooks/useToast', () => ({ useToast: () => showToast }));

const kanban: {
  groups: Record<string, unknown[]>;
  isLoading: boolean;
  error: string | null;
  servicesStatus: 'ok' | 'forbidden' | 'error' | undefined;
  moveStatus: () => Promise<null>;
} = {
  groups: { SOLICITANTE: [], ADMISSION: [], PENDING_ADMISSION: [], DONE: [] },
  isLoading: false,
  error: null,
  servicesStatus: 'ok',
  moveStatus: vi.fn(async () => null),
};
vi.mock('@hooks/admin/usePatientKanban', () => ({ usePatientKanban: () => kanban }));

vi.mock('@presentation/components/features/admin/PatientDetail/kanban/PatientKanbanBoard', () => ({
  PatientKanbanBoard: () => <div data-testid="board-stub" />,
}));

import { PatientKanbanPage } from '../PatientKanbanPage';

describe('PatientKanbanPage — aviso de falha do agregado do subcard (P13, DX-8.9)', () => {
  beforeEach(() => {
    kanban.servicesStatus = 'ok';
  });

  it("servicesStatus 'error' → mostra a linha de aviso", () => {
    kanban.servicesStatus = 'error';
    render(<PatientKanbanPage />);
    expect(screen.getByTestId('patient-kanban-services-error')).toHaveTextContent(
      'No se pudieron cargar los servicios de los pacientes.',
    );
    expect(screen.getByTestId('board-stub')).toBeInTheDocument();
  });

  it("servicesStatus 'ok' → não mostra a linha de aviso", () => {
    kanban.servicesStatus = 'ok';
    render(<PatientKanbanPage />);
    expect(screen.queryByTestId('patient-kanban-services-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('board-stub')).toBeInTheDocument();
  });

  it("servicesStatus 'forbidden' (403, o ator não lê serviços) → não mostra a linha de aviso", () => {
    kanban.servicesStatus = 'forbidden';
    render(<PatientKanbanPage />);
    expect(screen.queryByTestId('patient-kanban-services-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('board-stub')).toBeInTheDocument();
  });

  it("servicesStatus undefined (antes da 1ª carga assentar) → não mostra a linha de aviso", () => {
    kanban.servicesStatus = undefined;
    render(<PatientKanbanPage />);
    expect(screen.queryByTestId('patient-kanban-services-error')).not.toBeInTheDocument();
  });
});
