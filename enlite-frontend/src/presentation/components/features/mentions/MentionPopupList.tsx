/**
 * MentionPopupList — popup do autocomplete de `@` (spec 022, extraído de `MessageComposer.tsx`
 * na Rodada 2/R2-F). Renderizado via `ReactRenderer` do TipTap (`createMentionSuggestion.ts`),
 * fora da árvore React normal — mas é um componente React comum, testável isoladamente.
 *
 * Estado de erro (item 1, F5): `error` distingue "a busca falhou" de "0 resultados de verdade" —
 * `items` fica `[]` nos dois casos; só este flag diferencia (nunca uma mentira silenciosa).
 *
 * 🔒 TECLADO + ARIA (commit 3, Rodada 2/R2-F, mesmo padrão de `IcdSearchCombobox.tsx`): o foco
 * NUNCA sai do editor (contenteditable) enquanto o `@` está ativo — o `Suggestion` plugin do
 * TipTap intercepta o `keydown` no editor e repassa pro renderer via `onKeyDown`
 * (`@tiptap/suggestion`, `handleKeyDown`); Escape já é tratado pelo PRÓPRIO plugin antes de
 * chegar aqui (sempre fecha o popup, `dispatchExit`), então este componente só precisa saber
 * de ArrowUp/ArrowDown/Enter. Por isso o handle é exposto por `ref` (`useImperativeHandle`),
 * não por eventos DOM na lista — `createMentionSuggestion.ts` chama
 * `component.ref?.onKeyDown({ event })` no `render().onKeyDown` do suggestion, o padrão oficial
 * do TipTap para popups deste tipo.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import type { StaffDirectoryEntry } from '@infrastructure/http/AdminConversationApiService';

export interface MentionPopupListProps {
  items: StaffDirectoryEntry[];
  /** `true` quando a última chamada ao diretório falhou (rede/403/500) — distinto de "0
   * resultados de verdade" (F5, item 1). */
  error: boolean;
  command: (attrs: { id: string; label: string }) => void;
}

export interface MentionPopupListHandle {
  /** `true` = evento tratado aqui (o `Suggestion` plugin faz `preventDefault`, o editor nunca vê
   * a tecla); `false` = deixa o editor tratar normalmente (ex.: digitar uma letra). */
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const MentionPopupList = forwardRef<MentionPopupListHandle, MentionPopupListProps>(
  function MentionPopupList({ items, error, command }, ref) {
    const { t } = useTranslation();
    const [activeIndex, setActiveIndex] = useState(0);

    // Nova busca (nova identidade de `items`, ex.: resultado seguinte da mesma digitação) reseta
    // o destaque para o 1º item — nunca preso num índice que não existe mais na lista nova.
    useEffect(() => setActiveIndex(0), [items]);

    const selectItem = useCallback((index: number): void => {
      const item = items[index];
      if (!item) return;
      command({ id: item.uid, label: item.displayName });
    }, [items, command]);

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }): boolean => {
        if (error || items.length === 0) return false;
        if (event.key === 'ArrowDown') {
          setActiveIndex((i) => (i + 1) % items.length);
          return true;
        }
        if (event.key === 'ArrowUp') {
          setActiveIndex((i) => (i - 1 + items.length) % items.length);
          return true;
        }
        if (event.key === 'Enter') {
          selectItem(activeIndex);
          return true;
        }
        return false;
      },
    }), [items, error, activeIndex, selectItem]);

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
    if (items.length === 0) return null;

    const activeId = items[activeIndex] ? `composer-mention-option-${items[activeIndex].uid}` : undefined;

    return (
      <ul
        role="listbox"
        aria-label={t('admin.patients.detail.conversation.composer.mentionListLabel', 'Mencionar')}
        aria-activedescendant={activeId}
        data-testid="composer-mention-list"
        // `max-h` + `overflow-y-auto`: até `maxResults` resultados cabem numa lista mais alta que
        // muitos viewports — sem teto, o clamp vertical teria que abrir ACIMA de todo o histórico
        // da conversa para caber, o que nem sempre existe. Rolar por dentro é o padrão de popover
        // (item 1, design.md §1); 240px ≈ 6 itens visíveis antes de rolar.
        className="rounded-md border bg-white shadow-md py-1 max-h-[240px] overflow-y-auto"
      >
        {items.map((item, idx) => (
          <li key={item.uid} role="presentation">
            <button
              type="button"
              id={`composer-mention-option-${item.uid}`}
              role="option"
              aria-selected={idx === activeIndex}
              data-testid={`composer-mention-item-${item.uid}`}
              onClick={() => selectItem(idx)}
              onMouseEnter={() => setActiveIndex(idx)}
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100 ${idx === activeIndex ? 'bg-gray-100' : ''}`}
            >
              {item.displayName}
            </button>
          </li>
        ))}
      </ul>
    );
  },
);
