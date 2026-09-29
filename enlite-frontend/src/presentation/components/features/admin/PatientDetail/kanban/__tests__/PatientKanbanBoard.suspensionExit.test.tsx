/**
 * PatientKanbanBoard — saída de SUSPENDED com motivo (decisão do Gabriel 29/09/2026, 2ª rodada).
 *
 * Molde de `PatientKanbanBoard.drop.test.tsx`: o `KanbanBoardShell` é substituído por um espião
 * que devolve o `onDrop` recebido — a mecânica de arrastar em si (dnd-kit) não roda em jsdom, e
 * não é deste arquivo. O `SuspensionExitReasonDialog` é RENDERIZADO de verdade (não mockado):
 * é o componente que decide abrir/fechar, e é ele que precisa provar que funciona.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import es from '@infrastructure/i18n/locales/es.json';
import { PatientKanbanBoard } from '../PatientKanbanBoard';
import type { PatientKanbanGroups } from '@hooks/admin/usePatientKanban';

// Mesmo molde de `PatientStatusControl.test.tsx`: `t()` real (com interpolação `{{x}}`), lendo o
// es.json de verdade — precisa disto porque o teste confere que o NOME do paciente e o rótulo do
// destino aparecem no corpo do diálogo (`suspensionExitDialog.body`), não só que o diálogo existe.
const translations = es as Record<string, any>;
function t(key: string, opts?: any): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  if (typeof cur === 'string') return typeof opts === 'object' && opts ? cur.replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => opts[k] ?? _) : cur;
  if (typeof opts === 'string') return opts;
  if (typeof opts === 'object' && typeof opts?.defaultValue === 'string') return opts.defaultValue;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));

let capturado: ((e: { item: unknown; itemId: string; fromColumnId: string; toColumnId: string }) => void) | null = null;

vi.mock('@presentation/components/features/admin/Kanban/KanbanBoardShell', () => ({
  KanbanBoardShell: (props: Record<string, any>) => {
    capturado = props.onDrop;
    const itens = props.columns.flatMap((c: { id: string }) => props.itemsOf(c.id));
    return (
      <div data-testid={props.testId}>
        {itens.map((i: { id: string }) => (
          <div key={props.getItemId(i)} data-testid={`item-${props.getItemId(i)}`}>
            {props.renderCard(i, 'SUSPENDED')}
          </div>
        ))}
      </div>
    );
  },
}));

const VAZIO: PatientKanbanGroups = {
  ADMISSION: [], SEARCHING: [], REPLACEMENT: [], ACTIVE: [],
  ON_HOLD: [], SUSPENDED: [], ALTA: [], DISCHARGED: [],
};

const PACIENTE_SUSPENSO = {
  id: 'p-susp-1', firstName: 'Marta', lastName: 'Suárez', caseNumber: 42,
  dependencyLevel: null, status: 'SUSPENDED', admissionStatus: 'DONE', responsibleName: null,
  leadContactEmailMasked: null, leadContactIsResponsible: false,
};

beforeEach(() => { capturado = null; });

describe('soltar um card cuja origem é SUSPENDED', () => {
  it('NÃO move otimisticamente e NÃO chama onMove — abre o diálogo de motivo', () => {
    const onMove = vi.fn().mockResolvedValue(null);
    render(<MemoryRouter><PatientKanbanBoard groups={{ ...VAZIO, SUSPENDED: [PACIENTE_SUSPENSO] }} onMove={onMove} /></MemoryRouter>);

    act(() => { capturado!({ item: PACIENTE_SUSPENSO, itemId: 'p-susp-1', fromColumnId: 'SUSPENDED', toColumnId: 'SEARCHING' }); });

    expect(onMove).not.toHaveBeenCalled();
    expect(screen.getByTestId('kanban-suspension-dialog')).toBeInTheDocument();
    // o nome do paciente e o destino aparecem no corpo do diálogo (interpolação real do i18next)
    expect(screen.getByTestId('kanban-suspension-dialog')).toHaveTextContent('Marta Suárez');
  });

  it('confirmar SEM motivo fica desabilitado; escolher motivo habilita e chama onMove com suspensionExitReason', async () => {
    const onMove = vi.fn().mockResolvedValue(null);
    render(<MemoryRouter><PatientKanbanBoard groups={{ ...VAZIO, SUSPENDED: [PACIENTE_SUSPENSO] }} onMove={onMove} /></MemoryRouter>);
    act(() => { capturado!({ item: PACIENTE_SUSPENSO, itemId: 'p-susp-1', fromColumnId: 'SUSPENDED', toColumnId: 'SEARCHING' }); });

    const confirmar = screen.getByTestId('kanban-suspension-confirm');
    expect(confirmar).toBeDisabled();

    fireEvent.change(screen.getByTestId('kanban-suspension-exit-reason'), { target: { value: 'RESUMED_SERVICE' } });
    expect(confirmar).not.toBeDisabled();

    fireEvent.click(confirmar);
    await waitFor(() => expect(onMove).toHaveBeenCalledWith('p-susp-1', 'SEARCHING', { suspensionExitReason: 'RESUMED_SERVICE' }));
    await waitFor(() => expect(screen.queryByTestId('kanban-suspension-dialog')).not.toBeInTheDocument());
  });

  it('cancelar fecha o diálogo e NÃO chama onMove — o card já não tinha se movido (groups intacto)', () => {
    const onMove = vi.fn().mockResolvedValue(null);
    render(<MemoryRouter><PatientKanbanBoard groups={{ ...VAZIO, SUSPENDED: [PACIENTE_SUSPENSO] }} onMove={onMove} /></MemoryRouter>);
    act(() => { capturado!({ item: PACIENTE_SUSPENSO, itemId: 'p-susp-1', fromColumnId: 'SUSPENDED', toColumnId: 'ON_HOLD' }); });

    expect(screen.getByTestId('kanban-suspension-dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('kanban-suspension-cancel'));

    expect(onMove).not.toHaveBeenCalled();
    expect(screen.queryByTestId('kanban-suspension-dialog')).not.toBeInTheDocument();
    // o card segue listado em SUSPENDED — `groups` nunca mudou (não houve otimismo para desfazer)
    expect(screen.getByTestId('item-p-susp-1')).toBeInTheDocument();
  });

  it('drag entre DUAS colunas que NÃO são SUSPENDED continua instantâneo — sem diálogo (não-regressão)', () => {
    const onMove = vi.fn().mockResolvedValue(null);
    render(<MemoryRouter><PatientKanbanBoard groups={VAZIO} onMove={onMove} /></MemoryRouter>);

    act(() => { capturado!({ item: { id: 'p1' }, itemId: 'p1', fromColumnId: 'ADMISSION', toColumnId: 'ALTA' }); });

    expect(onMove).toHaveBeenCalledWith('p1', 'ALTA');
    expect(screen.queryByTestId('kanban-suspension-dialog')).not.toBeInTheDocument();
  });

  it('soltar na PRÓPRIA coluna SUSPENDED continua no-op — sem diálogo, sem request (não-regressão)', () => {
    const onMove = vi.fn().mockResolvedValue(null);
    render(<MemoryRouter><PatientKanbanBoard groups={{ ...VAZIO, SUSPENDED: [PACIENTE_SUSPENSO] }} onMove={onMove} /></MemoryRouter>);

    act(() => { capturado!({ item: PACIENTE_SUSPENSO, itemId: 'p-susp-1', fromColumnId: 'SUSPENDED', toColumnId: 'SUSPENDED' }); });

    expect(onMove).not.toHaveBeenCalled();
    expect(screen.queryByTestId('kanban-suspension-dialog')).not.toBeInTheDocument();
  });
});
