/**
 * MentionPopupList — teste unitário isolado (spec 022, Rodada 2/R2-F). O comportamento composto
 * (TipTap + editor real) já é coberto por `MessageComposer.test.tsx`; este teste cobre o
 * componente puro, sozinho, para o módulo de menção ser reusável fora do compositor sem depender
 * daquele teste maior.
 *
 * Popup estilo ClickUp (decisão do Gabriel, 22/09): avatar+bolinha de presença, primeiros N
 * (injetados via `items`, o CORTE é do `createMentionSuggestion`) + linha "Mostrar todos"
 * (`onShowAll` injetado — ausente = sem a linha, popup só mostra `items`) que carrega a lista
 * inteira com scroll; sem abas/filtros/agentes.
 *
 * Teclado + ARIA (padrão de `IcdSearchCombobox.tsx`): o foco fica no editor (contenteditable)
 * enquanto o `@` está ativo — ArrowUp/ArrowDown/Enter chegam via `MentionPopupListHandle.onKeyDown`
 * (exposto por `ref`), nunca por foco real de DOM na lista. "Mostrar todos" é mais uma OPÇÃO no
 * ciclo de teclado (alcançável por Arrow, ativado por Enter).
 */
import { createRef } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
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

afterEach(() => { vi.restoreAllMocks(); });

const ITEMS = [
  { uid: 'u-1', displayName: 'QA Staff Um', isOnline: true },
  { uid: 'u-2', displayName: 'QA Staff Dois', isOnline: false },
  { uid: 'u-3', displayName: 'QA Staff Três', isOnline: false },
];

function press(key: string): KeyboardEvent {
  return { key } as KeyboardEvent;
}

describe('MentionPopupList (estilo ClickUp, Rodada 2/R2-F)', () => {
  it('cada linha mostra avatar com presença + nome', () => {
    render(<MentionPopupList items={ITEMS} error={false} command={vi.fn()} />);
    const row = screen.getByTestId('composer-mention-item-u-1');
    expect(row).toHaveTextContent('QA Staff Um');
    expect(row.querySelector('[data-testid="person-avatar"]')).toBeInTheDocument();
    expect(row.querySelector('[data-testid="presence-dot"]')).toBeInTheDocument();
  });

  it('presença: online (u-1) vs offline (u-2) mostram bolinhas diferentes', () => {
    render(<MentionPopupList items={ITEMS} error={false} command={vi.fn()} />);
    const online = screen.getByTestId('composer-mention-item-u-1').querySelector('[data-testid="presence-dot"]');
    const offline = screen.getByTestId('composer-mention-item-u-2').querySelector('[data-testid="presence-dot"]');
    expect(online?.className).toMatch(/bg-green-600/);
    expect(offline?.className).toMatch(/bg-gray-800/);
  });

  it('chama command com {id,label} ao clicar numa linha', () => {
    const command = vi.fn();
    render(<MentionPopupList items={ITEMS} error={false} command={command} />);
    fireEvent.click(screen.getByTestId('composer-mention-item-u-2'));
    expect(command).toHaveBeenCalledWith({ id: 'u-2', label: 'QA Staff Dois' });
  });

  it('sem onShowAll: nenhuma linha "Mostrar todos" (popup só mostra os items recebidos)', () => {
    render(<MentionPopupList items={ITEMS} error={false} command={vi.fn()} />);
    expect(screen.queryByTestId('composer-mention-show-all')).not.toBeInTheDocument();
  });

  it('com onShowAll: mostra a linha "Mostrar todos" depois dos items', () => {
    render(<MentionPopupList items={ITEMS} error={false} command={vi.fn()} onShowAll={vi.fn()} />);
    expect(screen.getByTestId('composer-mention-show-all')).toBeInTheDocument();
  });

  it('clicar "Mostrar todos" chama onShowAll e troca a lista pelo resultado (com scroll — mesma classe max-h/overflow)', async () => {
    const allEntries = [...ITEMS, { uid: 'u-4', displayName: 'QA Staff Quatro', isOnline: false }];
    const onShowAll = vi.fn().mockResolvedValue(allEntries);
    render(<MentionPopupList items={ITEMS} error={false} command={vi.fn()} onShowAll={onShowAll} />);

    fireEvent.click(screen.getByTestId('composer-mention-show-all'));
    expect(onShowAll).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(screen.getByTestId('composer-mention-item-u-4')).toBeInTheDocument());
    // Depois de expandido, a linha "Mostrar todos" some (já mostra tudo).
    expect(screen.queryByTestId('composer-mention-show-all')).not.toBeInTheDocument();
    expect(screen.getByTestId('composer-mention-list').className).toMatch(/max-h-\[240px\]/);
    expect(screen.getByTestId('composer-mention-list').className).toMatch(/overflow-y-auto/);
  });

  it('"Mostrar todos" falha: mantém a lista de topo, mostra aviso de erro isolado', async () => {
    const onShowAll = vi.fn().mockRejectedValue(new Error('network'));
    render(<MentionPopupList items={ITEMS} error={false} command={vi.fn()} onShowAll={onShowAll} />);
    fireEvent.click(screen.getByTestId('composer-mention-show-all'));
    await waitFor(() => expect(screen.getByTestId('composer-mention-error')).toBeInTheDocument());
    expect(screen.getByTestId('composer-mention-item-u-1')).toBeInTheDocument();
  });

  it('items=[] sem onShowAll e sem erro: não renderiza nada', () => {
    const { container } = render(<MentionPopupList items={[]} error={false} command={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  // Rodada 3/R3-F, item 2: estado vazio honesto ("ninguém pode ser mencionado") — o CHAMADOR
  // (`createMentionSuggestion`) já verificou que a busca era sem filtro; aqui só a renderização.
  it('items=[] com emptyState=true: mostra a linha de estado vazio (distinta do erro)', () => {
    render(<MentionPopupList items={[]} error={false} emptyState command={vi.fn()} />);
    expect(screen.getByTestId('composer-mention-empty')).toBeInTheDocument();
    expect(screen.getByTestId('composer-mention-empty')).toHaveTextContent(
      resolve('admin.patients.detail.conversation.composer.mentionNoEligibleRecipients') as string,
    );
    expect(screen.queryByTestId('composer-mention-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('composer-mention-list')).not.toBeInTheDocument();
  });

  it('items=[] com emptyState=true, mas error=true: erro sempre vence (F5, nunca mentir "vazio" numa falha real)', () => {
    render(<MentionPopupList items={[]} error emptyState command={vi.fn()} />);
    expect(screen.getByTestId('composer-mention-error')).toBeInTheDocument();
    expect(screen.queryByTestId('composer-mention-empty')).not.toBeInTheDocument();
  });

  it('items não-vazio com emptyState=true (nunca acontece no uso real, mas a lista sempre vence): mostra a lista', () => {
    render(<MentionPopupList items={ITEMS} error={false} emptyState command={vi.fn()} />);
    expect(screen.getByTestId('composer-mention-list')).toBeInTheDocument();
    expect(screen.queryByTestId('composer-mention-empty')).not.toBeInTheDocument();
  });

  it('emptyState ausente (default false): items=[] continua sem renderizar nada — não quebra quem já usava o componente sem o flag', () => {
    const { container } = render(<MentionPopupList items={[]} error={false} command={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('composer-mention-empty')).not.toBeInTheDocument();
  });

  it('emptyState=true: onKeyDown nunca intercepta nada (nada pra navegar)', () => {
    const ref = createRef<MentionPopupListHandle>();
    render(<MentionPopupList ref={ref} items={[]} error={false} emptyState command={vi.fn()} />);
    expect(ref.current!.onKeyDown({ event: press('ArrowDown') })).toBe(false);
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

  it('ArrowDown/ArrowUp navegam com wrap-around', () => {
    const ref = createRef<MentionPopupListHandle>();
    render(<MentionPopupList ref={ref} items={ITEMS} error={false} command={vi.fn()} />);

    act(() => { ref.current!.onKeyDown({ event: press('ArrowDown') }); });
    expect(screen.getByTestId('composer-mention-item-u-2')).toHaveAttribute('aria-selected', 'true');
    act(() => { ref.current!.onKeyDown({ event: press('ArrowDown') }); });
    expect(screen.getByTestId('composer-mention-item-u-3')).toHaveAttribute('aria-selected', 'true');
    act(() => { ref.current!.onKeyDown({ event: press('ArrowDown') }); });
    expect(screen.getByTestId('composer-mention-item-u-1')).toHaveAttribute('aria-selected', 'true');
    act(() => { ref.current!.onKeyDown({ event: press('ArrowUp') }); });
    expect(screen.getByTestId('composer-mention-item-u-3')).toHaveAttribute('aria-selected', 'true');
  });

  // D2 (achado do e2e `mention-popup-clickup.integration.e2e.ts` alt 1, investigado com
  // instrumentação real): depois de "Mostrar todos" trocar a lista, a posição de tela que a
  // linha "Mostrar todos" ocupava passa a ter outro item — com o mouse PARADO ali (não moveu um
  // pixel), o Chromium ainda dispara `mouseenter`/`mouseover` pro item novo (hit-test recalculado
  // sob DOM que mudou embaixo do cursor estacionário). `mousemove` não tem esse problema: só
  // existe quando o dispositivo apontador se move de verdade. Por isso o hover deste popup ouve
  // `onMouseMove`, nunca `onMouseEnter` — o teste abaixo prova a diferença: um `mouseEnter puro
  // (sem `mouseMove` antes) NÃO deve mudar o item ativo (é exatamente o padrão do hover fantasma:
  // o elemento aparece sob o cursor sem ele se mexer), mas um `mouseMove` de verdade muda.
  it('D2: hover fantasma (mouseenter sem mousemove) NÃO muda o item ativo — só mousemove real muda', () => {
    render(<MentionPopupList items={ITEMS} error={false} command={vi.fn()} />);
    const itemButton = screen.getByTestId('composer-mention-item-u-3');

    fireEvent.mouseEnter(itemButton);
    expect(screen.getByTestId('composer-mention-item-u-1')).toHaveAttribute('aria-selected', 'true');
    expect(itemButton).toHaveAttribute('aria-selected', 'false');

    fireEvent.mouseMove(itemButton);
    expect(itemButton).toHaveAttribute('aria-selected', 'true');
  });

  it('"Mostrar todos" é alcançável por teclado — ArrowDown depois do último item chega nela, Enter ativa', async () => {
    const onShowAll = vi.fn().mockResolvedValue(ITEMS);
    const ref = createRef<MentionPopupListHandle>();
    render(<MentionPopupList ref={ref} items={ITEMS} error={false} command={vi.fn()} onShowAll={onShowAll} />);

    // 3 items (índices 0-2) + "Mostrar todos" (índice 3) — 4 ArrowDown a partir do 0 chega nela.
    act(() => { ref.current!.onKeyDown({ event: press('ArrowDown') }); }); // u-2
    act(() => { ref.current!.onKeyDown({ event: press('ArrowDown') }); }); // u-3
    act(() => { ref.current!.onKeyDown({ event: press('ArrowDown') }); }); // "Mostrar todos"
    expect(screen.getByTestId('composer-mention-show-all')).toHaveAttribute('aria-selected', 'true');

    await act(async () => { ref.current!.onKeyDown({ event: press('Enter') }); });
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });

  it('Enter num item (não "Mostrar todos") chama command, nunca onShowAll', () => {
    const command = vi.fn();
    const onShowAll = vi.fn();
    const ref = createRef<MentionPopupListHandle>();
    render(<MentionPopupList ref={ref} items={ITEMS} error={false} command={command} onShowAll={onShowAll} />);
    act(() => { ref.current!.onKeyDown({ event: press('Enter') }); });
    expect(command).toHaveBeenCalledWith({ id: 'u-1', label: 'QA Staff Um' });
    expect(onShowAll).not.toHaveBeenCalled();
  });

  it('tecla irrelevante não é interceptada — devolve false', () => {
    const ref = createRef<MentionPopupListHandle>();
    render(<MentionPopupList ref={ref} items={ITEMS} error={false} command={vi.fn()} />);
    expect(ref.current!.onKeyDown({ event: press('a') })).toBe(false);
  });

  it('lista vazia ou em erro: onKeyDown nunca intercepta nada', () => {
    const ref = createRef<MentionPopupListHandle>();
    render(<MentionPopupList ref={ref} items={[]} error command={vi.fn()} />);
    expect(ref.current!.onKeyDown({ event: press('ArrowDown') })).toBe(false);
  });

  it('nova busca (items muda de identidade) reseta o destaque E volta pro topo (sai do modo "todos")', async () => {
    const onShowAll = vi.fn().mockResolvedValue([...ITEMS, { uid: 'u-4', displayName: 'Quatro', isOnline: false }]);
    const ref = createRef<MentionPopupListHandle>();
    const { rerender } = render(<MentionPopupList ref={ref} items={ITEMS} error={false} command={vi.fn()} onShowAll={onShowAll} />);

    fireEvent.click(screen.getByTestId('composer-mention-show-all'));
    await waitFor(() => expect(screen.getByTestId('composer-mention-item-u-4')).toBeInTheDocument());

    // Nova digitação: TipTap manda um `items` novo (nova identidade) — volta pro topo com a
    // linha "Mostrar todos" de novo, nunca presa na lista "todos" da busca anterior.
    rerender(<MentionPopupList ref={ref} items={[ITEMS[2]]} error={false} command={vi.fn()} onShowAll={onShowAll} />);
    expect(screen.queryByTestId('composer-mention-item-u-4')).not.toBeInTheDocument();
    expect(screen.getByTestId('composer-mention-item-u-3')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('composer-mention-show-all')).toBeInTheDocument();
  });
});
