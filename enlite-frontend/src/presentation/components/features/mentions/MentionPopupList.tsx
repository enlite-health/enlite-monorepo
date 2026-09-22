/**
 * MentionPopupList — popup do autocomplete de `@`, estilo ClickUp (spec 022, Rodada 2/R2-F;
 * decisão do Gabriel 22/09 — referência de LAYOUT só, sem copiar nomes/rótulos de print nenhum).
 * Renderizado via `ReactRenderer` do TipTap (`createMentionSuggestion.ts`), fora da árvore React
 * normal — mas é um componente React comum, testável isoladamente.
 *
 * Cada linha = avatar com iniciais + bolinha de presença (`PersonAvatar`/`PresenceDot`, mesmos
 * átomos do card de mensagem) + nome. Sem abas/filtros/agentes — só a lista (`items`, já cortada
 * pelo `createMentionSuggestion` para os primeiros N) e, quando `onShowAll` é injetado, uma linha
 * final "Mostrar todos" que carrega a lista INTEIRA (até o teto do backend) e substitui a visão de
 * topo por ela — com scroll (mesma classe `max-h`/`overflow-y-auto` de antes, nunca um popup sem
 * teto). Uma nova busca (nova identidade de `items`, ao digitar) sempre volta pro topo — nunca
 * presa na visão "todos" de uma busca anterior.
 *
 * Estado de erro (item 1, F5): `error` distingue "a busca falhou" de "0 resultados de verdade" —
 * `items` fica `[]` nos dois casos; só este flag diferencia (nunca uma mentira silenciosa). Falha
 * do PRÓPRIO "Mostrar todos" é um erro ISOLADO — não derruba a lista de topo já visível.
 *
 * 🔒 TECLADO + ARIA (mesmo padrão de `IcdSearchCombobox.tsx`): o foco NUNCA sai do editor
 * (contenteditable) enquanto o `@` está ativo — o `Suggestion` plugin do TipTap intercepta o
 * `keydown` no editor e repassa pro renderer via `onKeyDown`; Escape já é tratado pelo PRÓPRIO
 * plugin antes de chegar aqui (sempre fecha o popup). "Mostrar todos" é mais uma OPÇÃO no ciclo de
 * ArrowUp/ArrowDown (índice virtual = depois do último item) — Enter nela dispara `onShowAll` em
 * vez de `command`. O handle é exposto por `ref` (`useImperativeHandle`), o padrão oficial do
 * TipTap para popups deste tipo.
 *
 * 🔒 HOVER SÓ EM `onMouseMove`, NUNCA `onMouseEnter` (D2, achado do e2e
 * `mention-popup-clickup.integration.e2e.ts` alt 1 — investigado com instrumentação real, não
 * presumido): clicar em "Mostrar todos" troca a visão de topo (5 itens + linha) pela lista
 * inteira (11 itens, scroll) — a linha que a "Mostrar todos" ocupava antes de sumir passa a ser
 * ocupada por OUTRO item, na MESMA posição de tela. Com o mouse parado exatamente ali (ele acabou
 * de clicar "Mostrar todos", nunca se moveu), o Chromium recalcula o hit-test sob o cursor
 * ESTACIONÁRIO e dispara `mouseenter`/`mouseover` PARA O ITEM NOVO — sem o usuário ter movido o
 * mouse um pixel. Medido: log do próprio `onMouseEnter` mostrava exatamente 1 disparo, ANTES até
 * do `editor.click()` seguinte no teste (ou seja, é a REFLOW da lista, não o clique) — e ele
 * pisava o `activeIndex` que o ArrowUp usa em seguida, fazendo o wrap-around aterrissar num item
 * errado. `mousemove` (ao contrário de `mouseenter`/`mouseover`) só existe quando o dispositivo
 * apontador FISICAMENTE se move — o padrão de combobox (WAI-ARIA APG) de "teclado manda, hover só
 * conta depois que o mouse mexer de novo" cai de graça usando este evento em vez do outro; não
 * precisa de nenhum estado extra (`lastMousePos` etc.) porque o próprio browser já garante que
 * `mousemove` não refira por causa de DOM mudando embaixo do cursor parado.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { PersonAvatar } from '@presentation/components/atoms/PersonAvatar';
import type { StaffDirectoryEntry } from '@infrastructure/http/AdminConversationApiService';

export interface MentionPopupListProps {
  items: StaffDirectoryEntry[];
  /** `true` quando a última chamada ao diretório falhou (rede/403/500) — distinto de "0
   * resultados de verdade" (F5, item 1). */
  error: boolean;
  command: (attrs: { id: string; label: string }) => void;
  /** Carrega TODOS os mencionáveis (até o teto do backend) — habilita a linha "Mostrar todos".
   * Ausente = sem essa linha, o popup só mostra `items`. Injetado (nunca importa um client HTTP
   * direto) — mesma régua de `createMentionSuggestion`/`fetchCandidates`. */
  onShowAll?: () => Promise<StaffDirectoryEntry[]>;
  /**
   * Rodada 3/R3-F (item 2): `true` só quando o CHAMADOR já verificou que a busca voltou vazia SEM
   * filtro nenhum (`query === ''`) — ou seja, ninguém pode ser mencionado de verdade (ex.:
   * `patientId` filtra e nenhum outro staff tem acesso à conversa), nunca "esta busca específica
   * não bateu com ninguém". Distinto de `error` (F5, item 1): aqui a chamada teve SUCESSO, só que
   * o resultado é genuinamente vazio. Ausente/`false` preserva o comportamento antigo (0 itens
   * sem filtro nenhum de erro nem de vazio-honesto = não renderiza nada, ex.: busca com texto que
   * não bate com ninguém). */
  emptyState?: boolean;
}

export interface MentionPopupListHandle {
  /** `true` = evento tratado aqui (o `Suggestion` plugin faz `preventDefault`, o editor nunca vê
   * a tecla); `false` = deixa o editor tratar normalmente (ex.: digitar uma letra). */
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const MentionPopupList = forwardRef<MentionPopupListHandle, MentionPopupListProps>(
  function MentionPopupList({ items, error, command, onShowAll, emptyState = false }, ref) {
    const { t } = useTranslation();
    const [activeIndex, setActiveIndex] = useState(0);
    /** `null` = visão de topo (`items`); array = "Mostrar todos" já carregado — substitui `items`
     * por inteiro (nunca concatena: a resposta de `loadAll` já é a lista completa). */
    const [allItems, setAllItems] = useState<StaffDirectoryEntry[] | null>(null);
    const [allLoading, setAllLoading] = useState(false);
    const [allError, setAllError] = useState(false);

    // Nova busca (nova identidade de `items`, ex.: nova digitação) SEMPRE volta pro topo — nunca
    // presa num índice ou numa visão "todos" que não correspondem mais à busca atual.
    useEffect(() => {
      setActiveIndex(0);
      setAllItems(null);
      setAllError(false);
    }, [items]);

    const visibleItems = allItems ?? items;
    // Rodada 3/R3-F (item 2): sem NENHUM candidato na visão de topo, "Mostrar todos" não tem o
    // que buscar de novo (a mesma busca sem filtro voltaria vazia de novo) — mostrá-lo ali seria
    // prometer mais gente pra quem já é a lista completa (vazia). `visibleItems.length > 0` é a
    // guarda; sem ela, o estado vazio (abaixo) nunca aparecia — a linha "Mostrar todos" sozinha
    // já deixava `optionCount` em 1, nunca 0.
    const showAllRowVisible = allItems === null && !!onShowAll && visibleItems.length > 0;
    /** Índice VIRTUAL da linha "Mostrar todos" — sempre o último slot do ciclo de teclado. */
    const showAllIndex = visibleItems.length;
    const optionCount = visibleItems.length + (showAllRowVisible ? 1 : 0);

    const selectItem = useCallback((index: number): void => {
      const item = visibleItems[index];
      if (!item) return;
      command({ id: item.uid, label: item.displayName });
    }, [visibleItems, command]);

    const handleShowAll = useCallback((): void => {
      if (!onShowAll || allLoading) return;
      setAllLoading(true);
      setAllError(false);
      onShowAll()
        .then((results) => {
          setAllItems(results);
          setActiveIndex(0);
        })
        .catch(() => setAllError(true))
        .finally(() => setAllLoading(false));
    }, [onShowAll, allLoading]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }): boolean => {
        if (error || optionCount === 0) return false;
        if (event.key === 'ArrowDown') {
          setActiveIndex((i) => (i + 1) % optionCount);
          return true;
        }
        if (event.key === 'ArrowUp') {
          setActiveIndex((i) => (i - 1 + optionCount) % optionCount);
          return true;
        }
        if (event.key === 'Enter') {
          if (showAllRowVisible && activeIndex === showAllIndex) {
            handleShowAll();
          } else {
            selectItem(activeIndex);
          }
          return true;
        }
        return false;
      },
    }), [error, optionCount, activeIndex, showAllRowVisible, showAllIndex, selectItem, handleShowAll]);

    if (error) {
      return (
        <div
          data-testid="composer-mention-error"
          role="alert"
          className="rounded-md border bg-white shadow-md px-3 py-2"
        >
          <Text as="span" size="xs" color="secondary">
            {t('admin.patients.detail.conversation.composer.mentionDirectoryError')}
          </Text>
        </div>
      );
    }
    if (optionCount === 0) {
      // Rodada 3/R3-F (item 2): honesto ("ninguém pode ser mencionado") em vez de silencioso —
      // só quando o CHAMADOR sinalizou `emptyState` (busca sem filtro, resultado vazio, sem
      // erro). Sem o flag, preserva o comportamento antigo (nada renderizado).
      if (emptyState) {
        return (
          <div
            data-testid="composer-mention-empty"
            role="status"
            className="rounded-md border bg-white shadow-md px-3 py-2"
          >
            <Text as="span" size="xs" color="secondary">
              {t('admin.patients.detail.conversation.composer.mentionNoEligibleRecipients')}
            </Text>
          </div>
        );
      }
      return null;
    }

    const activeId = activeIndex === showAllIndex && showAllRowVisible
      ? 'composer-mention-showall'
      : visibleItems[activeIndex]
        ? `composer-mention-option-${visibleItems[activeIndex].uid}`
        : undefined;

    return (
      <ul
        role="listbox"
        aria-label={t('admin.patients.detail.conversation.composer.mentionListLabel', 'Mencionar')}
        aria-activedescendant={activeId}
        data-testid="composer-mention-list"
        // `max-h` + `overflow-y-auto`: mesmo com "Mostrar todos" (até 200 entradas), o popup NUNCA
        // cresce sem teto — sem isto o clamp vertical teria que abrir ACIMA de todo o histórico da
        // conversa para caber, o que nem sempre existe. Rolar por dentro é o padrão de popover
        // (item 1, design.md §1); 240px ≈ 6 itens visíveis antes de rolar.
        className="rounded-md border bg-white shadow-md py-1 max-h-[240px] overflow-y-auto"
      >
        {visibleItems.map((item, idx) => (
          <li key={item.uid} role="presentation">
            <button
              type="button"
              id={`composer-mention-option-${item.uid}`}
              role="option"
              aria-selected={idx === activeIndex}
              data-testid={`composer-mention-item-${item.uid}`}
              onClick={() => selectItem(idx)}
              onMouseMove={() => setActiveIndex(idx)}
              // P3 (achado do gate): `bg-gray-100` (#FFF9FC, paleta CUSTOM) sobre o `bg-white` do
              // popup é quase o MESMO branco — o destaque do item ativo/hover não se enxergava.
              // `bg-gray-600` (#D9D9D9) é o cinza mais claro desta escala que ainda se distingue
              // a olho nu contra branco (memória "escala de cinza não é Tailwind": só 600 e 800
              // são visíveis; 100-500 somem).
              className={`w-full flex items-center gap-2 text-left px-3 py-1.5 hover:bg-gray-600 ${idx === activeIndex ? 'bg-gray-600' : ''}`}
            >
              <PersonAvatar uid={item.uid} name={item.displayName} size={24} presence={item.isOnline ? 'online' : 'offline'} />
              {/* P3: nome em `color="primary"` (text-primary, #180149, 18.43:1) — antes usava o
                  default do `Text` (`secondary` → `text-gray-800`, 4.74:1: passa o piso AA por
                  pouca margem e lê como "apagado" para um NOME, que é a informação principal da
                  linha). */}
              <Text as="span" size="sm" color="primary" className="truncate">{item.displayName}</Text>
            </button>
          </li>
        ))}
        {showAllRowVisible && (
          <li role="presentation">
            <button
              type="button"
              id="composer-mention-showall"
              role="option"
              aria-selected={activeIndex === showAllIndex}
              data-testid="composer-mention-show-all"
              onClick={handleShowAll}
              onMouseMove={() => setActiveIndex(showAllIndex)}
              disabled={allLoading}
              // Mesmo destaque de P3 acima — evita a MESMA linha (idx ativo) ter highlight visível
              // e esta (showAllIndex ativo) ficar com o bg-gray-100 quase invisível de antes.
              className={`w-full text-left px-3 py-1.5 hover:bg-gray-600 ${activeIndex === showAllIndex ? 'bg-gray-600' : ''}`}
            >
              <Text as="span" size="sm" weight="medium" color="primary">
                {allLoading ? t('common.loading') : t('admin.patients.detail.conversation.composer.mentionShowAll')}
              </Text>
            </button>
          </li>
        )}
        {allError && (
          <li className="px-3 py-1.5" data-testid="composer-mention-error">
            <Text as="span" size="xs" color="secondary" role="alert">
              {t('admin.patients.detail.conversation.composer.mentionDirectoryError')}
            </Text>
          </li>
        )}
      </ul>
    );
  },
);
