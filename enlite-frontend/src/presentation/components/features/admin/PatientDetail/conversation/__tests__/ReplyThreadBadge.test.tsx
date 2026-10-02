/**
 * ReplyThreadBadge — testes unitários (ajustes de UI B5, rodada 2, pedido do Gabriel: selo em vez
 * de texto "N respuestas").
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { ReplyThreadBadge } from '../ReplyThreadBadge';

const translations = ptBR as Record<string, unknown>;
function resolve(key: string): unknown {
  return key.split('.').reduce((acc: any, part) => acc?.[part], translations);
}
function t(key: string, opts?: Record<string, unknown> | string): string {
  if (opts && typeof opts === 'object' && typeof opts.count === 'number') {
    const suffix = opts.count === 1 ? '_one' : '_other';
    const raw = resolve(`${key}${suffix}`) ?? resolve(key);
    if (typeof raw === 'string') return raw.replace('{{count}}', String(opts.count));
    return key;
  }
  const raw = resolve(key);
  if (typeof raw === 'string') return raw;
  if (typeof opts === 'string') return opts;
  return key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));

describe('ReplyThreadBadge', () => {
  it('count 0: NENHUM selo (nem vazio) — só "Responder" existe fora deste componente', () => {
    const { container } = render(<ReplyThreadBadge count={0} onOpenThread={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('count 3: mostra "3" e aria-label descritivo com a contagem real', () => {
    render(<ReplyThreadBadge count={3} onOpenThread={vi.fn()} />);
    const badge = screen.getByTestId('conversation-message-replies');
    expect(badge).toHaveTextContent('3');
    expect(badge).toHaveAttribute('aria-label', '3 respostas');
    expect(badge).toHaveAttribute('title', '3 respostas');
  });

  it('count 1 (singular): aria-label no singular', () => {
    render(<ReplyThreadBadge count={1} onOpenThread={vi.fn()} />);
    expect(screen.getByTestId('conversation-message-replies')).toHaveAttribute('aria-label', '1 resposta');
  });

  it('count 120: mostra "99+" no selo, mas o aria-label leva a contagem REAL (120), nunca capada', () => {
    render(<ReplyThreadBadge count={120} onOpenThread={vi.fn()} />);
    const badge = screen.getByTestId('conversation-message-replies');
    expect(badge).toHaveTextContent('99+');
    expect(badge).toHaveAttribute('aria-label', '120 respostas');
  });

  it('count exatamente 100: também vira "99+" (cap é em >99, não em >=100... na verdade o limite é 99)', () => {
    render(<ReplyThreadBadge count={100} onOpenThread={vi.fn()} />);
    expect(screen.getByTestId('conversation-message-replies')).toHaveTextContent('99+');
  });

  it('count exatamente 99: mostra "99" (não capado ainda)', () => {
    render(<ReplyThreadBadge count={99} onOpenThread={vi.fn()} />);
    expect(screen.getByTestId('conversation-message-replies')).toHaveTextContent('99');
  });

  it('clique no selo INTEIRO chama onOpenThread', () => {
    const onOpenThread = vi.fn();
    render(<ReplyThreadBadge count={5} onOpenThread={onOpenThread} />);
    screen.getByTestId('conversation-message-replies').click();
    expect(onOpenThread).toHaveBeenCalledTimes(1);
  });

  it('tem o ícone de balão de conversa (svg) dentro do selo', () => {
    render(<ReplyThreadBadge count={2} onOpenThread={vi.fn()} />);
    expect(screen.getByTestId('conversation-message-replies').querySelector('svg')).toBeInTheDocument();
  });
});
