import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VacancyFunnelTableRow } from './VacancyFunnelTableRow';
import type { FunnelTableRow } from '@domain/entities/Funnel';
import es from '@infrastructure/i18n/locales/es.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@presentation/components/atoms/WorkerAvatar', () => ({
  WorkerAvatar: ({ name }: { name: string | null }) => (
    <div data-testid="worker-avatar">{name}</div>
  ),
}));

vi.mock('@presentation/components/atoms/WhatsappStatusBadge', () => ({
  WhatsappStatusBadge: ({ status }: { status: string | null }) => (
    <span data-testid="whatsapp-badge">{status}</span>
  ),
}));

const baseRow: FunnelTableRow = {
  id: 'row-1',
  workerId: 'w-1',
  workerName: 'Juan Pérez',
  workerEmail: 'juan@example.com',
  workerPhone: '+54 9 11 1234-5678',
  workerAvatarUrl: null,
  invitedAt: '2026-01-15T00:00:00.000Z',
  funnelStage: 'INVITED',
  whatsappStatus: 'SENT',
  whatsappLastDispatchedAt: null,
  accepted: true,
  interviewResponse: null,
  registrationComplete: true,
  contactNotesCount: 2,
  kanbanColumn: null,
  isBlocked: false,
};

function renderRow(row: FunnelTableRow, onOpenNotes = vi.fn()) {
  return render(
    <table>
      <tbody>
        <VacancyFunnelTableRow row={row} isLast={false} onOpenNotes={onOpenNotes} />
      </tbody>
    </table>,
  );
}

// DX-5.7 (achado 🟡-2 do gate parcial da Fase 5): a linha redigida de Compatíveis sem
// `match:read` chega com workerId=null (FunnelTableRow.ts:30 já é nullable no back);
// o botão de notas depende de um par worker×vaga que essa linha não tem — sem o guard,
// clicar chamava onOpenNotes(null) e o modal abria sem worker (ContactNotesModal exige
// workerId: string).
describe('VacancyFunnelTableRow — linha redigida (workerId null)', () => {
  it('desabilita o botão de notas quando workerId é null (redigida)', () => {
    const onOpenNotes = vi.fn();
    renderRow({ ...baseRow, workerId: null, workerName: 'Contato restrito' }, onOpenNotes);
    const button = screen.getByTestId('funnel-notes-button');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onOpenNotes).not.toHaveBeenCalled();
  });

  it('controle positivo: botão de notas presente e habilitado quando workerId existe', () => {
    const onOpenNotes = vi.fn();
    renderRow({ ...baseRow, workerId: 'w-1' }, onOpenNotes);
    const button = screen.getByTestId('funnel-notes-button');
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onOpenNotes).toHaveBeenCalledWith('w-1');
  });

  it('linha redigida também não renderiza o link de perfil (workerId null)', () => {
    renderRow({ ...baseRow, workerId: null, workerName: 'Contato restrito' });
    expect(screen.queryByTestId('funnel-worker-link')).not.toBeInTheDocument();
  });
});

// 054 item 2: Origen/ACEPTÓ saem da Lista.
describe('VacancyFunnelTableRow — sem Origen nem ACEPTÓ (054 item 2)', () => {
  it('não renderiza o selo de auto-postulação nem o rótulo de aceite', () => {
    renderRow({ ...baseRow, selfAppliedAt: '2026-08-07T13:51:19.923Z', accepted: true });
    expect(screen.queryByTestId('funnel-self-applied-badge')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.vacancyDetail.funnelTable.acceptedYes')).not.toBeInTheDocument();
    renderRow({ ...baseRow, accepted: false });
    expect(screen.queryByText('admin.vacancyDetail.funnelTable.acceptedNo')).not.toBeInTheDocument();
  });
});

// 054 item 3: REGISTRO é a 3ª célula, logo depois do nome.
describe('VacancyFunnelTableRow — REGISTRO na 3ª célula (054 item 3)', () => {
  it('a 3ª célula é o badge Completo/Incompleto', () => {
    const { unmount } = renderRow({ ...baseRow, registrationComplete: true });
    expect(screen.getAllByRole('cell')[2]).toHaveTextContent('admin.vacancyDetail.funnelTable.registration.complete');
    unmount();
    renderRow({ ...baseRow, registrationComplete: false });
    expect(screen.getAllByRole('cell')[2]).toHaveTextContent('admin.vacancyDetail.funnelTable.registration.incomplete');
  });
});

// 054 item 4: ETAPA lê row.kanbanColumn pelo mapa sources → id (IN_PROGRESS aparece como Pre Screening).
describe('VacancyFunnelTableRow — ETAPA (054 item 4)', () => {
  const stageCell = () => screen.getByTestId('funnel-stage-row-1');
  const kanbanLabels = es.admin.kanban.columns as Record<string, string>;

  it('IN_PROGRESS mostra o rótulo de PRE_SCREENING ("Pre Screening"), nunca "En Progreso"', () => {
    renderRow({ ...baseRow, kanbanColumn: 'IN_PROGRESS' });
    expect(stageCell()).toHaveTextContent('admin.kanban.columns.PRE_SCREENING');
    expect(stageCell()).toHaveAttribute('data-stage', 'PRE_SCREENING');
    expect(kanbanLabels.PRE_SCREENING).toBe('Pre Screening');
  });

  it('COMPATIBLE mostra o rótulo de COMPATIBLE ("Compatibles")', () => {
    renderRow({ ...baseRow, kanbanColumn: 'COMPATIBLE' });
    expect(stageCell()).toHaveTextContent('admin.kanban.columns.COMPATIBLE');
    expect(stageCell()).toHaveAttribute('data-stage', 'COMPATIBLE');
    expect(kanbanLabels.COMPATIBLE).toBe('Compatibles');
  });

  it('kanbanColumn nulo ou fora do mapa mostra "—" e nenhum data-stage', () => {
    const { unmount } = renderRow({ ...baseRow, kanbanColumn: null });
    expect(stageCell()).toHaveTextContent('—');
    expect(stageCell()).not.toHaveAttribute('data-stage');
    unmount();
    renderRow({ ...baseRow, kanbanColumn: 'FOO' });
    expect(stageCell()).toHaveTextContent('—');
    expect(stageCell()).not.toHaveAttribute('data-stage');
  });

  it('a ETAPA é a 4ª célula, logo depois de REGISTRO', () => {
    renderRow({ ...baseRow, kanbanColumn: 'INVITED' });
    expect(screen.getAllByRole('cell')[3]).toContainElement(stageCell());
  });
});
