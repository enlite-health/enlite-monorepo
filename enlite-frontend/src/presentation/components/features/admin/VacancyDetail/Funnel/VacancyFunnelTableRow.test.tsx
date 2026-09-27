import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { VacancyFunnelTableRow } from './VacancyFunnelTableRow';
import type { FunnelTableRow } from '@domain/entities/Funnel';

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
