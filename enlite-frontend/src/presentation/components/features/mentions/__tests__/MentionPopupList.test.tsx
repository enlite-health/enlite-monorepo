/**
 * MentionPopupList — teste unitário isolado (spec 022, Rodada 2/R2-F, extraído de
 * `MessageComposer.tsx`). O comportamento composto (TipTap + editor real) já é coberto por
 * `MessageComposer.test.tsx`; este teste cobre o componente puro, sozinho, para o módulo de
 * menção ser reusável fora do compositor sem depender daquele teste maior.
 *
 * Teclado + ARIA (commit 3, Rodada 2/R2-F, padrão de `IcdSearchCombobox.tsx`): o foco fica no
 * editor (contenteditable) enquanto o `@` está ativo — ArrowUp/ArrowDown/Enter chegam via
 * `MentionPopupListHandle.onKeyDown` (exposto por `ref`, é assim que `createMentionSuggestion`
 * intercepta), nunca por foco real de DOM na lista. Por isso o teste chama `ref.current.onKeyDown`
 * diretamente, em vez de `fireEvent.keyDown` num elemento (que não teria efeito nenhum — o
 * elemento do popup nunca tem foco).
 */
import { createRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { MentionPopupList, type MentionPopupListHandle } from '../MentionPopupList';

/** Mesmo padrão de `MessageComposer.test.tsx`: espelha o `t` real contra o pt-BR.json de verdade. */
const translations = ptBR as Record<string, unknown>;
function resolve(key: string): unknown {
  return key.split('.').reduce((acc: any, part) => acc?.[part], translations);
}
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const raw = resolve(key);
      return typeof raw === 'string' ? raw : (fallback ?? key);
    },
  }),
}));

const ITEMS = [
  { uid: 'u-1', displayName: 'QA Staff Um', isOnline: false },
  { uid: 'u-2', displayName: 'QA Staff Dois', isOnline: false },
  { uid: 'u-3', displayName: 'QA Staff Três', isOnline: false },
];

function press(key: string): KeyboardEvent {
  return { key } as KeyboardEvent;
}

describe('MentionPopupList (extraído do MessageComposer, Rodada 2/R2-F)', () => {
  it('lista os candidatos e chama command com {id,label} ao clicar', () => {
    const command = vi.fn();
    render(<MentionPopupList items={[ITEMS[0]]} error={false} command={command} />);
    expect(screen.getByTestId('composer-mention-item-u-1')).toHaveTextContent('QA Staff Um');
    fireEvent.click(screen.getByTestId('composer-mention-item-u-1'));
    expect(command).toHaveBeenCalledWith({ id: 'u-1', label: 'QA Staff Um' });
  });

  it('items=[] sem erro: não renderiza nada (nem lista nem erro)', () => {
    const { container } = render(<MentionPopupList items={[]} error={false} command={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('error=true: mostra o aviso de falha, nunca a lista (distinto de "0 resultados")', () => {
    render(<MentionPopupList items={[]} error command={vi.fn()} />);
    expect(screen.getByTestId('composer-mention-error')).toBeInTheDocument();
    expect(screen.queryByTestId('composer-mention-list')).not.toBeInTheDocument();
  });

  it('ARIA: role=listbox/option e aria-activedescendant aponta pro item ativo (1º por padrão)', () => {
    render(<MentionPopupList items={ITEMS} error={false} command={vi.fn()} />);
    const list = screen.getByTestId('composer-mention-list');
    expect(list).toHaveAttribute('role', 'listbox');
    expect(screen.getByTestId('composer-mention-item-u-1')).toHaveAttribute('role', 'option');
    expect(list).toHaveAttribute('aria-activedescendant', screen.getByTestId('composer-mention-item-u-1').id);
    expect(screen.getByTestId('composer-mention-item-u-1')).toHaveAttribute('aria-selected', 'true');
  });

  it('ArrowDown/ArrowUp movem o destaque (via handle exposto por ref, nunca por foco de DOM)', () => {
    const ref = createRef<MentionPopupListHandle>();
    render(<MentionPopupList ref={ref} items={ITEMS} error={false} command={vi.fn()} />);

    let handled: boolean | undefined;
    act(() => { handled = ref.current!.onKeyDown({ event: press('ArrowDown') }); });
    expect(handled).toBe(true);
    expect(screen.getByTestId('composer-mention-item-u-2')).toHaveAttribute('aria-selected', 'true');

    act(() => { ref.current!.onKeyDown({ event: press('ArrowDown') }); });
    expect(screen.getByTestId('composer-mention-item-u-3')).toHaveAttribute('aria-selected', 'true');

    // Wrap-around: do último volta pro primeiro.
    act(() => { ref.current!.onKeyDown({ event: press('ArrowDown') }); });
    expect(screen.getByTestId('composer-mention-item-u-1')).toHaveAttribute('aria-selected', 'true');

    act(() => { ref.current!.onKeyDown({ event: press('ArrowUp') }); });
    expect(screen.getByTestId('composer-mention-item-u-3')).toHaveAttribute('aria-selected', 'true');
  });

  it('Enter seleciona o item ATIVO (não sempre o primeiro)', () => {
    const command = vi.fn();
    const ref = createRef<MentionPopupListHandle>();
    render(<MentionPopupList ref={ref} items={ITEMS} error={false} command={command} />);

    act(() => { ref.current!.onKeyDown({ event: press('ArrowDown') }); }); // ativo agora é u-2
    let handled: boolean | undefined;
    act(() => { handled = ref.current!.onKeyDown({ event: press('Enter') }); });
    expect(handled).toBe(true);
    expect(command).toHaveBeenCalledWith({ id: 'u-2', label: 'QA Staff Dois' });
  });

  it('tecla irrelevante (ex.: letra) não é interceptada — devolve false, deixa o editor tratar', () => {
    const ref = createRef<MentionPopupListHandle>();
    render(<MentionPopupList ref={ref} items={ITEMS} error={false} command={vi.fn()} />);
    expect(ref.current!.onKeyDown({ event: press('a') })).toBe(false);
  });

  it('lista vazia ou em erro: onKeyDown nunca intercepta nada (devolve false)', () => {
    const ref = createRef<MentionPopupListHandle>();
    render(<MentionPopupList ref={ref} items={[]} error command={vi.fn()} />);
    expect(ref.current!.onKeyDown({ event: press('ArrowDown') })).toBe(false);
  });

  it('nova busca (items muda de identidade) reseta o destaque para o 1º item', () => {
    const ref = createRef<MentionPopupListHandle>();
    const { rerender } = render(<MentionPopupList ref={ref} items={ITEMS} error={false} command={vi.fn()} />);
    act(() => { ref.current!.onKeyDown({ event: press('ArrowDown') }); }); // ativo agora é u-2
    rerender(<MentionPopupList ref={ref} items={[ITEMS[2]]} error={false} command={vi.fn()} />);
    expect(screen.getByTestId('composer-mention-item-u-3')).toHaveAttribute('aria-selected', 'true');
  });
});
