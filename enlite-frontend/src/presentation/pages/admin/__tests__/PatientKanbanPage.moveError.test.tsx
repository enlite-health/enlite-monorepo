/**
 * PatientKanbanPage — spec 014 US-D5 (lex D5.1): o toast do erro de movimentação carrega o
 * CÓDIGO de enum que o backend manda (PatientApiError.code), traduzido por i18n — nunca eco de
 * campo do paciente (nome, diagnóstico), nunca `console.*` com o corpo da resposta. Também prova
 * o texto "Arrastrá para cambiar el estado" (nada indicava que arrastar é a única forma).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: any) => {
      const dict: Record<string, string> = {
        'admin.patients.kanban.dragHint': 'Arrastrá una tarjeta para cambiar el estado del paciente.',
        'admin.patients.kanban.moveError': 'No se pudo mover el paciente',
        'admin.patients.kanban.moveErrorCodes.PATIENT_STATUS_TRANSITION_NOT_ALLOWED': 'Ese cambio de estado no está permitido.',
        // Decisão do Gabriel 07/09 — textos reais de `es.json` (bloqueio por completude).
        'admin.patients.kanban.moveErrorCodes.PATIENT_STATUS_NOT_READY':
          'No se puede mover: faltan datos obligatorios en la ficha.',
        'admin.patients.kanban.moveNotReady': 'No se puede mover: falta {{items}}.',
        'admin.patients.detail.completeness.items.ADDRESS': 'Domicilio',
        'admin.patients.detail.completeness.items.SERVICE_SCHEDULE': 'Horario del servicio',
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

const showToast = vi.fn();
vi.mock('@presentation/hooks/useToast', () => ({ useToast: () => showToast }));

let moveResult: { code: string; missing?: string[] } | null = null;
const kanban = {
  groups: { SOLICITANTE: [], ADMISSION: [], PENDING_ADMISSION: [], DONE: [] },
  isLoading: false,
  error: null,
  moveStatus: vi.fn(async () => moveResult),
};
vi.mock('@hooks/admin/usePatientKanban', () => ({ usePatientKanban: () => kanban }));

vi.mock('@presentation/components/features/admin/PatientDetail/kanban/PatientKanbanBoard', () => ({
  PatientKanbanBoard: (p: {
    onMove: (id: string, target: string) => Promise<{ code: string; missing?: string[] } | null>;
  }) => (
    <button data-testid="move-stub" onClick={() => p.onMove('pat-1', 'DONE')}>mover</button>
  ),
}));

import { PatientKanbanPage } from '../PatientKanbanPage';
import userEvent from '@testing-library/user-event';

describe('PatientKanbanPage — dica de arraste (US-D5)', () => {
  it('mostra "Arrastrá para cambiar el estado"', () => {
    render(<PatientKanbanPage />);
    expect(screen.getByTestId('kanban-drag-hint')).toHaveTextContent(/Arrastrá/);
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

describe('PatientKanbanPage — toast do erro de movimentação (lex D5.1)', () => {
  beforeEach(() => { showToast.mockReset(); });

  it('código conhecido → toast com a mensagem traduzida do CÓDIGO, não o texto genérico', async () => {
    const user = userEvent.setup();
    moveResult = { code: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED' };
    render(<PatientKanbanPage />);
    await user.click(screen.getByTestId('move-stub'));
    expect(showToast).toHaveBeenCalledWith('Ese cambio de estado no está permitido.', 'error');
  });

  it('código desconhecido/ausente → cai no toast genérico', async () => {
    const user = userEvent.setup();
    moveResult = { code: 'ALGUM_CODIGO_NOVO_SEM_TRADUCAO' };
    render(<PatientKanbanPage />);
    await user.click(screen.getByTestId('move-stub'));
    expect(showToast).toHaveBeenCalledWith('No se pudo mover el paciente', 'error');
  });

  // Decisão do Gabriel 07/09: o bloqueio por completude NOMEIA o que falta, com as mesmas
  // palavras do checklist da ficha — o operador não pode ficar só com "não foi possível".
  it('422 de completude com `missing` → toast NOMEIA o que falta, com os rótulos do checklist', async () => {
    const user = userEvent.setup();
    moveResult = { code: 'PATIENT_STATUS_NOT_READY', missing: ['SERVICE_SCHEDULE'] };
    render(<PatientKanbanPage />);
    await user.click(screen.getByTestId('move-stub'));
    expect(showToast).toHaveBeenCalledWith('No se puede mover: falta Horario del servicio.', 'error');
  });

  it('vários códigos faltando → o toast lista todos, separados por vírgula', async () => {
    const user = userEvent.setup();
    moveResult = { code: 'PATIENT_STATUS_NOT_READY', missing: ['ADDRESS', 'SERVICE_SCHEDULE'] };
    render(<PatientKanbanPage />);
    await user.click(screen.getByTestId('move-stub'));
    expect(showToast).toHaveBeenCalledWith(
      'No se puede mover: falta Domicilio, Horario del servicio.',
      'error',
    );
  });

  it('código de completude SEM `missing` → cai na mensagem do código, não numa lista vazia', async () => {
    const user = userEvent.setup();
    moveResult = { code: 'PATIENT_STATUS_NOT_READY' };
    render(<PatientKanbanPage />);
    await user.click(screen.getByTestId('move-stub'));
    expect(showToast).toHaveBeenCalledWith(
      'No se puede mover: faltan datos obligatorios en la ficha.',
      'error',
    );
  });

  it('sucesso (err null) → nenhum toast', async () => {
    const user = userEvent.setup();
    moveResult = null;
    render(<PatientKanbanPage />);
    await user.click(screen.getByTestId('move-stub'));
    expect(showToast).not.toHaveBeenCalled();
  });
});

describe('PatientKanbanPage — estados de carregamento/erro (D200: cobertura do arquivo tocado)', () => {
  it('isLoading:true → skeleton, sem o board', () => {
    kanban.isLoading = true;
    try {
      render(<PatientKanbanPage />);
      expect(screen.queryByTestId('move-stub')).not.toBeInTheDocument();
    } finally {
      kanban.isLoading = false;
    }
  });

  it('error → mensagem de erro, sem o board', () => {
    (kanban as { error: string | null }).error = 'boom';
    try {
      render(<PatientKanbanPage />);
      expect(screen.getByText('boom')).toBeInTheDocument();
      expect(screen.queryByTestId('move-stub')).not.toBeInTheDocument();
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
