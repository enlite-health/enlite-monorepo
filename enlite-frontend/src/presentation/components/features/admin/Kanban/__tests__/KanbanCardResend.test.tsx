/**
 * KanbanCardResend.test.tsx — a seção "Reenviar" (REQ-08 / D200.1): estados idle/sending/sent/error,
 * último envio, motivo bloqueado com "disponível desde", clique não propaga ao card (drag).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KanbanCardResend } from '../KanbanCardResend';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts && 'date' in opts ? `${key}:${opts.date}` : key) }),
}));

describe('KanbanCardResend', () => {
  it('idle sem envio: botão habilitado sem título, "sem envios", clique chama onResend e não propaga', () => {
    const onResend = vi.fn(); const parent = vi.fn();
    render(<div onClick={parent}><KanbanCardResend onResend={onResend} lastMessagedAt={null} blockedReason={null} /></div>);
    const btn = screen.getByTestId('resend-button');
    expect(btn).not.toBeDisabled();
    expect(btn).not.toHaveAttribute('title');
    expect(btn).toHaveTextContent('admin.kanban.resendButton');
    expect(screen.getByTestId('resend-last-sent')).toHaveTextContent('admin.kanban.neverSent');
    expect(screen.queryByTestId('resend-blocked-reason')).toBeNull();
    expect(screen.queryByTestId('resend-feedback')).toBeNull();
    fireEvent.click(btn);
    expect(onResend).toHaveBeenCalledTimes(1); expect(parent).not.toHaveBeenCalled();
  });

  it('blockedReason desabilita o botão, põe o título e mostra o motivo + quando a janela abre', () => {
    const onResend = vi.fn();
    render(<KanbanCardResend onResend={onResend} lastMessagedAt="2026-08-28T17:35:00.000Z" blockedReason={{ code: 'RESEND_COOLDOWN', until: '2026-08-29T17:35:00.000Z' }} />);
    const btn = screen.getByTestId('resend-button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'admin.messaging.blocked.RESEND_COOLDOWN');
    expect(screen.getByTestId('resend-last-sent').textContent).toMatch(/admin\.kanban\.lastSentAt:28\/0?8/);
    const reason = screen.getByTestId('resend-blocked-reason');
    expect(reason).toHaveTextContent('admin.messaging.blocked.RESEND_COOLDOWN');
    expect(reason.textContent).toMatch(/admin\.kanban\.resendBlockedUntil:29\/0?8/);
    fireEvent.click(btn);
    expect(onResend).not.toHaveBeenCalled();
  });

  it('sending desabilita e troca o texto; sent/error mostram o feedback; error sem mensagem não mostra nada', () => {
    const { rerender } = render(<KanbanCardResend onResend={() => undefined} status="sending" />);
    const btn = screen.getByTestId('resend-button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent('admin.kanban.resendSending');
    rerender(<KanbanCardResend onResend={() => undefined} status="sent" />);
    expect(screen.getByTestId('resend-feedback')).toHaveTextContent('admin.kanban.resendDone');
    expect(screen.getByTestId('resend-feedback')).not.toHaveAttribute('role');
    rerender(<KanbanCardResend onResend={() => undefined} status="error" message="Ya se le reenvió" />);
    expect(screen.getByTestId('resend-feedback')).toHaveTextContent('Ya se le reenvió');
    expect(screen.getByTestId('resend-feedback')).toHaveAttribute('role', 'alert');
    rerender(<KanbanCardResend onResend={() => undefined} status="error" message={null} />);
    expect(screen.queryByTestId('resend-feedback')).toBeNull();
    rerender(<KanbanCardResend onResend={() => undefined} lastMessagedAt="não-é-data" />);
    expect(screen.getByTestId('resend-last-sent').textContent).toContain('não-é-data');
  });
});
