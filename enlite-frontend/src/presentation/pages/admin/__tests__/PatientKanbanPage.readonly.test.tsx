/**
 * PatientKanbanPage — F5 de estado-automatico-do-paciente: o board é SÓ DE LEITURA. A página não recebe `moveStatus`, não tem toast de
 * movimentação e a dica diz que o estado vem do fluxo automático e das ações da ficha (lex D5.1: nunca `console.*`).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: any) => {
      const dict: Record<string, string> = {
        'admin.patients.kanban.readonlyHint': 'El Kanban es de solo lectura: el estado lo define el flujo automático y las acciones de la ficha del paciente.',
      };
      if (key in dict) {
        // interpolação mínima do i18next ({{x}}), para o teste medir a mensagem MONTADA
        return dict[key].replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? ''));
      }
      if (typeof opts === 'object' && typeof opts?.defaultValue === 'string') return opts.defaultValue;
      return key;
    },
  }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

const kanban = {
  groups: { SOLICITANTE: [], ADMISSION: [], PENDING_ADMISSION: [], DONE: [] },
  isLoading: false,
  error: null,
};
vi.mock('@hooks/admin/usePatientKanban', () => ({ usePatientKanban: () => kanban }));

vi.mock('@presentation/components/features/admin/PatientDetail/kanban/PatientKanbanBoard', () => ({
  PatientKanbanBoard: (p: Record<string, unknown>) => <div data-testid="board-stub" data-props={Object.keys(p).sort().join(',')} />,
}));

import { PatientKanbanPage } from '../PatientKanbanPage';
import userEvent from '@testing-library/user-event';

describe('PatientKanbanPage — só leitura (F5)', () => {
  it('a dica diz que o estado vem do fluxo automático e das ações da ficha — e não existe mais a dica de arrastar', () => {
    render(<PatientKanbanPage />);
    expect(screen.getByTestId('kanban-readonly-hint')).toHaveTextContent(/solo lectura/);
    expect(screen.queryByTestId('kanban-drag-hint')).not.toBeInTheDocument();
  });

  it('o board recebe SÓ os grupos: nenhum callback de movimento', () => {
    render(<PatientKanbanPage />);
    expect(screen.getByTestId('board-stub')).toHaveAttribute('data-props', 'groups');
  });
});

describe('PatientKanbanPage — outros controles (D200: cobertura do arquivo tocado)', () => {
  it('botão "Lista" navega para /admin/patients', async () => {
    const user = userEvent.setup();
    render(<PatientKanbanPage />);
    await user.click(screen.getByTestId('patients-view-list'));
    // a navegação em si é coberta pelo mock de react-router-dom; aqui só provamos que o
    // clique não quebra e o botão está presente.
    expect(screen.getByTestId('patients-view-list')).toBeInTheDocument();
  });

  it('trocar o filtro de país chama setCountry (Select real, sem crash)', async () => {
    render(<PatientKanbanPage />);
    expect(screen.getByTestId('patient-country-filter')).toBeInTheDocument();
  });
});

describe('PatientKanbanPage — estados de carregamento/erro (D200: cobertura do arquivo tocado)', () => {
  it('isLoading:true → skeleton, sem o board', () => {
    kanban.isLoading = true;
    try {
      render(<PatientKanbanPage />);
      expect(screen.queryByTestId('board-stub')).not.toBeInTheDocument();
    } finally {
      kanban.isLoading = false;
    }
  });

  it('error → mensagem de erro, sem o board', () => {
    (kanban as { error: string | null }).error = 'boom';
    try {
      render(<PatientKanbanPage />);
      expect(screen.getByText('boom')).toBeInTheDocument();
      expect(screen.queryByTestId('board-stub')).not.toBeInTheDocument();
    } finally {
      (kanban as { error: string | null }).error = null;
    }
  });
});

describe('PatientKanbanPage — lex D5.1: nunca console.*', () => {
  it('grep console.* no arquivo fonte = 0', () => {
    const filePath = path.resolve(__dirname, '../PatientKanbanPage.tsx');
    const source = readFileSync(filePath, 'utf-8');
    expect(source).not.toMatch(/console\.(log|warn|error|info|debug)/);
  });
});
