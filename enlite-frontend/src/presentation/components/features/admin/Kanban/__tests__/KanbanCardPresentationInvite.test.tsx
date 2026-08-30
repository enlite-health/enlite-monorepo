/**
 * KanbanCardPresentationInvite.test.tsx — o botão "Invitar a reunión de presentación" (REQ-09):
 * estados (idle/sending/queued/skipped/error), último convite, clique não propaga.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KanbanCardPresentationInvite } from '../KanbanCardPresentationInvite';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: string | Record<string, unknown>) => (typeof opts === 'string' ? opts : opts && typeof opts === 'object' && 'date' in opts ? `${key}:${opts.date}` : key) }),
}));

describe('KanbanCardPresentationInvite', () => {
  it('idle sem convite: botão habilitado, "sem convite", clique chama onInvite e não propaga', () => {
    const onInvite = vi.fn(); const parent = vi.fn();
    render(<div onClick={parent}><KanbanCardPresentationInvite onInvite={onInvite} /></div>);
    expect(screen.getByTestId('presentation-invite-button')).not.toBeDisabled();
    expect(screen.getByTestId('presentation-invite-last')).toHaveTextContent('admin.presentationInvite.never');
    expect(screen.queryByTestId('presentation-invite-feedback')).toBeNull();
    fireEvent.click(screen.getByTestId('presentation-invite-button'));
    expect(onInvite).toHaveBeenCalledTimes(1); expect(parent).not.toHaveBeenCalled();
  });

  it('sending desabilita; queued/skipped/error mostram o feedback certo; último convite formatado', () => {
    const { rerender } = render(<KanbanCardPresentationInvite onInvite={() => undefined} state={{ status: 'sending' }} lastInvitedAt="2026-08-29T15:00:00Z" />);
    expect(screen.getByTestId('presentation-invite-button')).toBeDisabled();
    expect(screen.getByTestId('presentation-invite-button')).toHaveTextContent('admin.presentationInvite.sending');
    expect(screen.getByTestId('presentation-invite-last').textContent).toMatch(/admin\.presentationInvite\.lastAt:29\/0?8/);
    rerender(<KanbanCardPresentationInvite onInvite={() => undefined} state={{ status: 'queued' }} compact />);
    expect(screen.getByTestId('presentation-invite-feedback')).toHaveTextContent('admin.presentationInvite.queued');
    rerender(<KanbanCardPresentationInvite onInvite={() => undefined} state={{ status: 'skipped', detail: 'OPT_OUT' }} />);
    expect(screen.getByTestId('presentation-invite-feedback')).toHaveTextContent('OPT_OUT');
    rerender(<KanbanCardPresentationInvite onInvite={() => undefined} state={{ status: 'skipped' }} />);
    expect(screen.getByTestId('presentation-invite-feedback')).toHaveTextContent('admin.presentationInvite.skip.UNKNOWN');
    rerender(<KanbanCardPresentationInvite onInvite={() => undefined} state={{ status: 'error', detail: 'boom' }} />);
    expect(screen.getByTestId('presentation-invite-feedback')).toHaveTextContent('boom');
    rerender(<KanbanCardPresentationInvite onInvite={() => undefined} state={{ status: 'error' }} />);
    expect(screen.getByTestId('presentation-invite-feedback')).toHaveTextContent('admin.presentationInvite.error');
    rerender(<KanbanCardPresentationInvite onInvite={() => undefined} lastInvitedAt="not-a-date" />);
    expect(screen.getByTestId('presentation-invite-last').textContent).toContain('not-a-date');
  });
});
