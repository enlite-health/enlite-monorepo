/**
 * MentionPopupList — popup do autocomplete de `@` (spec 022, extraído de `MessageComposer.tsx`
 * na Rodada 2/R2-F, commit "extrair módulo de menção" — sem mudança visual/comportamental).
 *
 * Renderizado via `ReactRenderer` do TipTap (`createMentionSuggestion.ts`), fora da árvore React
 * normal — mas é um componente React comum, testável isoladamente.
 *
 * Estado de erro (item 1, F5): `error` distingue "a busca falhou" de "0 resultados de verdade" —
 * `items` fica `[]` nos dois casos; só este flag diferencia (nunca uma mentira silenciosa).
 */
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

export function MentionPopupList({ items, error, command }: MentionPopupListProps): JSX.Element | null {
  const { t } = useTranslation();
  if (error) {
    return (
      <div
        data-testid="composer-mention-error"
        className="rounded-md border bg-white shadow-md px-3 py-2"
      >
        <Text as="span" size="xs" color="secondary">
          {t('admin.patients.detail.conversation.composer.mentionDirectoryError')}
        </Text>
      </div>
    );
  }
  if (items.length === 0) return null;
  return (
    <ul
      data-testid="composer-mention-list"
      // `max-h` + `overflow-y-auto`: até `maxResults` resultados cabem numa lista mais alta que
      // muitos viewports — sem teto, o clamp vertical teria que abrir ACIMA de todo o histórico
      // da conversa para caber, o que nem sempre existe. Rolar por dentro é o padrão de popover
      // (item 1, design.md §1); 240px ≈ 6 itens visíveis antes de rolar.
      className="rounded-md border bg-white shadow-md py-1 max-h-[240px] overflow-y-auto"
    >
      {items.map((item) => (
        <li key={item.uid}>
          <button
            type="button"
            data-testid={`composer-mention-item-${item.uid}`}
            onClick={() => command({ id: item.uid, label: item.displayName })}
            className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-100"
          >
            {item.displayName}
          </button>
        </li>
      ))}
    </ul>
  );
}
