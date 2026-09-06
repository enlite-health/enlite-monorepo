import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const refetch = vi.fn().mockResolvedValue(undefined);
vi.mock('@hooks/admin/useWJAFunnel', () => ({
  useWJAFunnel: () => ({
    data: { stages: {}, totalEncuadres: 0 },
    isLoading: false,
    error: null,
    refetch,
    moveEncuadre: vi.fn(),
    rejectBlocked: vi.fn(),
    unrejectBlocked: vi.fn(),
  }),
}));

const sendVacancyMatchInvite = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { sendVacancyMatchInvite: (...a: unknown[]) => sendVacancyMatchInvite(...a) },
}));

// O board vira um botão que dispara o handler e mostra o retorno.
const resultBox: { last: string | null | undefined } = { last: undefined };
vi.mock('@presentation/components/features/admin/Kanban/KanbanBoard', () => ({
  KanbanBoard: ({ onResendInvite }: { onResendInvite?: (w: string) => Promise<string | null> }) => (
    <button
      data-testid="fake-resend"
      onClick={async () => { resultBox.last = await onResendInvite!('w-1'); }}
    >
      resend
    </button>
  ),
}));

import { InviteBlockedError } from '@infrastructure/http/AdminMessagingApiService';
import { VacancyFunnelKanban } from './VacancyFunnelKanban';

describe('VacancyFunnelKanban — handleResendInvite (REQ-08)', () => {
  beforeEach(() => { sendVacancyMatchInvite.mockReset(); refetch.mockClear(); resultBox.last = undefined; });

  it('sucesso: chama a API com resend:true, recarrega o funil e devolve null', async () => {
    sendVacancyMatchInvite.mockResolvedValue({});
    render(<VacancyFunnelKanban vacancyId="vac-1" />);
    fireEvent.click(screen.getByTestId('fake-resend'));
    await waitFor(() => expect(resultBox.last).toBeNull());
    expect(sendVacancyMatchInvite).toHaveBeenCalledWith('w-1', 'vac-1', { resend: true });
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('recusa 422 → mensagem localizada pelo código', async () => {
    sendVacancyMatchInvite.mockRejectedValue(new InviteBlockedError('RESEND_COOLDOWN', 'janela'));
    render(<VacancyFunnelKanban vacancyId="vac-1" />);
    fireEvent.click(screen.getByTestId('fake-resend'));
    await waitFor(() => expect(resultBox.last).toBe('admin.messaging.blocked.RESEND_COOLDOWN'));
    expect(refetch).not.toHaveBeenCalled();
  });

  it('falha genérica → mensagem do erro; erro sem mensagem → fallback', async () => {
    sendVacancyMatchInvite.mockRejectedValue(new Error('Periskope error'));
    const { unmount } = render(<VacancyFunnelKanban vacancyId="vac-1" />);
    fireEvent.click(screen.getByTestId('fake-resend'));
    await waitFor(() => expect(resultBox.last).toBe('Periskope error'));
    unmount();
    sendVacancyMatchInvite.mockRejectedValue(new Error(''));
    render(<VacancyFunnelKanban vacancyId="vac-1" />);
    fireEvent.click(screen.getByTestId('fake-resend'));
    await waitFor(() => expect(resultBox.last).toBe('admin.messaging.statusErrorFallback'));
  });
});
