/**
 * KanbanCardStageMessage.test.tsx — a linha "Mensaje de etapa" da tarjeta (DEC-12 / PEND-14).
 * O slug do template vai no `title` (hover); sem slug, sem title.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KanbanCardStageMessage } from '../KanbanCardStageMessage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string | Record<string, unknown>) => (typeof fallback === 'string' ? fallback : key) }),
}));
vi.mock('../kanbanCardFormat', () => ({ formatLastSent: (iso: string) => `fmt(${iso})` }));

describe('KanbanCardStageMessage', () => {
  it('sem lastStageMessage (undefined ou null) → nada', () => {
    const { container } = render(<KanbanCardStageMessage />);
    expect(container.firstChild).toBeNull();
    const { container: c2 } = render(<KanbanCardStageMessage lastStageMessage={null} />);
    expect(c2.firstChild).toBeNull();
  });

  it('com slug → title = slug; a etapa resolve pela coluna do Kanban e a data pelo formatador', () => {
    render(<KanbanCardStageMessage lastStageMessage={{ stage: 'COMPLETED', templateSlug: 'tpl_x', at: '2026-08-29T12:00:00Z' }} />);
    const el = screen.getByTestId('stage-last-message');
    expect(el).toHaveAttribute('title', 'tpl_x');
    expect(el.textContent).toContain('admin.kanban.stageLastMessage');
  });

  it('sem slug (template removido depois do envio) → sem atributo title', () => {
    render(<KanbanCardStageMessage lastStageMessage={{ stage: 'COMPLETED', templateSlug: null, at: '2026-08-29T12:00:00Z' }} />);
    expect(screen.getByTestId('stage-last-message')).not.toHaveAttribute('title');
  });
});
