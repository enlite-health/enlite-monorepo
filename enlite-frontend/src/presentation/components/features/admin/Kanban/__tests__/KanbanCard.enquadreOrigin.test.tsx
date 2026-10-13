import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KanbanCard } from '../KanbanCard';

// i18n mock — devolve a chave e o código, para asserir o caminho exato e o que vai na etiqueta
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { code?: string }) => (o?.code ? `${k}|${o.code}` : k) }),
}));

const base = {
  id: 'c-1', workerId: 'w-1', workerName: 'Ficticio 01', workerPhone: null, occupation: null, workZone: null, matchScore: null,
  talentumStatus: null, rejectionReasonCategory: null, interviewDate: null, interviewTime: null,
};
const ORIGIN = { eventCode: 'ENC-ABC123' };

describe('KanbanCard — etiqueta do enquadre de origem (spec 052, ajuste do Gabriel)', () => {
  it('(a) em SELECTED sem o campo não mostra etiqueta', () => {
    render(<KanbanCard {...base} stage="SELECTED" />);
    expect(screen.queryByTestId('enquadre-origin-badge')).not.toBeInTheDocument();
  });

  it('(b) em COMPLETED, mesmo com o campo, não mostra etiqueta', () => {
    render(<KanbanCard {...base} stage="COMPLETED" enquadreOrigin={ORIGIN} />);
    expect(screen.queryByTestId('enquadre-origin-badge')).not.toBeInTheDocument();
  });

  it('(c) SELECTED e QUICK_RESPONSE_TEAM com o campo mostram o texto de cada um, com o código', () => {
    const { unmount } = render(<KanbanCard {...base} stage="SELECTED" enquadreOrigin={ORIGIN} />);
    expect(screen.getByTestId('enquadre-origin-badge').textContent).toBe('admin.vacancyDetail.enquadre.kanban.originSelected|ENC-ABC123');
    unmount();
    render(<KanbanCard {...base} stage="QUICK_RESPONSE_TEAM" enquadreOrigin={ORIGIN} />);
    expect(screen.getByTestId('enquadre-origin-badge').textContent).toBe('admin.vacancyDetail.enquadre.kanban.originQuickResponse|ENC-ABC123');
  });

  it('(d) outros estágios (COMPATIBLE, INVITED, REJECTED) também ignoram o campo', () => {
    for (const stage of ['COMPATIBLE', 'INVITED', 'REJECTED']) {
      const { unmount } = render(<KanbanCard {...base} stage={stage} enquadreOrigin={ORIGIN} />);
      expect(screen.queryByTestId('enquadre-origin-badge')).not.toBeInTheDocument();
      unmount();
    }
  });
});
