/**
 * VacancyFunnelKanban.presentation.test.tsx — o handler do convite à reunión de presentación (REQ-09)
 * chega ao board com a origem 'kanban' e a vaga anexada.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@hooks/admin/useWJAFunnel', () => ({
  useWJAFunnel: () => ({ data: { stages: {}, totalEncuadres: 0 }, isLoading: false, error: null, refetch: vi.fn(), moveEncuadre: vi.fn(), rejectBlocked: vi.fn(), unrejectBlocked: vi.fn() }),
}));
const invite = vi.fn();
vi.mock('@infrastructure/http/AdminPresentationInviteApiService', () => ({
  AdminPresentationInviteApiService: { invite: (...a: unknown[]) => invite(...a) },
}));
const box: { last: unknown } = { last: undefined };
vi.mock('@presentation/components/features/admin/Kanban/KanbanBoard', () => ({
  KanbanBoard: ({ onPresentationInvite }: { onPresentationInvite?: (w: string) => Promise<unknown> }) => (
    <button data-testid="fake-invite" onClick={async () => { box.last = await onPresentationInvite!('w-1'); }}>invite</button>
  ),
}));

import { VacancyFunnelKanban } from './VacancyFunnelKanban';

describe('VacancyFunnelKanban — convite à reunión de presentación', () => {
  it('chama o serviço com (worker, "kanban", vacancyId) e devolve o resultado ao board', async () => {
    invite.mockResolvedValue({ status: 'queued', outboxId: 'o1' });
    render(<VacancyFunnelKanban vacancyId="vac-9" />);
    fireEvent.click(screen.getByTestId('fake-invite'));
    await waitFor(() => expect(box.last).toEqual({ status: 'queued', outboxId: 'o1' }));
    expect(invite).toHaveBeenCalledWith('w-1', 'kanban', 'vac-9');
  });
});
