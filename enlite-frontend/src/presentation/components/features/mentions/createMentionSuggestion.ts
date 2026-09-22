/**
 * createMentionSuggestion — configura o `suggestion` do `Mention` extension do TipTap (spec 022,
 * extraído de `MessageComposer.tsx` na Rodada 2/R2-F). Sem mudança visual/comportamental nesta
 * extração — a fonte de candidatos é INJETADA (`fetchCandidates`), nunca importada direto daqui,
 * para o módulo de menção ser reusável em qualquer campo com `@` (não só o compositor de
 * conversa) sem acoplar a um client HTTP específico.
 *
 * 🔒 POPUP ANCORADO NO CURSOR (F4, `mentionPopupPosition.ts`): lê `props.clientRect()` (posição
 * real do cursor, calculada pelo próprio TipTap) e usa `clampMentionPopupPosition` (aritmética
 * pura) para nunca deixar o popup nascer fora do viewport. Decisão de design mantida: NÃO usa
 * Popper/Floating UI (mesmo com o `mount` gerenciado disponível no `@tiptap/suggestion` 3.x) —
 * aritmética simples sobre um retângulo já disponível.
 *
 * `applyPosition`/`reposition` reaplicam a posição dentro de `requestAnimationFrame`: o
 * `ReactRenderer` do TipTap só faz o commit real do conteúdo de forma assíncrona — sem isto,
 * `getBoundingClientRect()` devolve `{width:0,height:0}` no primeiro frame e o clamp vertical
 * nunca detecta que faltaria espaço abaixo.
 */
import { ReactRenderer } from '@tiptap/react';
import type { SuggestionOptions } from '@tiptap/suggestion';
import type { MentionNodeAttrs } from '@tiptap/extension-mention';
import type { StaffDirectoryEntry } from '@infrastructure/http/AdminConversationApiService';
import { clampMentionPopupPosition } from './mentionPopupPosition';
import { MentionPopupList, type MentionPopupListHandle, type MentionPopupListProps } from './MentionPopupList';

export interface ConfigureMentionSuggestionOptions {
  /** Busca candidatos por texto (`query` vazia = sem filtro, primeiros N do diretório — item 1). */
  fetchCandidates: (query: string) => Promise<StaffDirectoryEntry[]>;
  /** Carrega a lista INTEIRA de mencionáveis (até o teto do backend) — usado pelo "Mostrar todos"
   * do popup estilo ClickUp (Rodada 2). Opcional: quem não precisa (nenhum "Mostrar todos") não
   * passa nada, e o popup não oferece a ação. */
  loadAll?: () => Promise<StaffDirectoryEntry[]>;
  /** Default 0 (item 1, revoga D-06): TipTap chama `items()` a partir do próprio `@`, sem exigir
   * nenhum caractere depois. */
  minQueryLength?: number;
  /** Teto de itens exibidos por chamada de `fetchCandidates` (não afeta `loadAll`). */
  maxResults?: number;
  /** Chamado com o resultado bruto de CADA `fetchCandidates` bem-sucedida — quem injeta usa isto
   * para efeitos colaterais (ex.: alimentar um cache de nome), sem o módulo de menção conhecer o
   * cache por dentro. */
  onResults?: (results: StaffDirectoryEntry[]) => void;
}

type MentionSuggestion = Omit<SuggestionOptions<StaffDirectoryEntry, MentionNodeAttrs>, 'editor'>;

export function configureMentionSuggestion(options: ConfigureMentionSuggestionOptions): MentionSuggestion {
  const { fetchCandidates, loadAll, minQueryLength = 0, maxResults = 20, onResults } = options;

  // Closure compartilhada entre `items()` e `render()` (item 1, F5) — falha de rede vira `[]`
  // (autocomplete não é canal de alerta), mas o popup MOSTRA que falhou em vez de mentir "nenhum
  // resultado". TipTap resolve `items()` ANTES de chamar `onStart`/`onUpdate`, então a flag já
  // está atualizada a tempo.
  let lastDirectoryError = false;

  return {
    char: '@',
    minQueryLength,
    items: async ({ query }): Promise<StaffDirectoryEntry[]> => {
      try {
        const results = await fetchCandidates(query);
        onResults?.(results);
        lastDirectoryError = false;
        return results.slice(0, maxResults);
      } catch {
        lastDirectoryError = true;
        return [];
      }
    },
    render: () => {
      let component: ReactRenderer<MentionPopupListHandle, MentionPopupListProps> | null = null;

      const applyPosition = (rect: DOMRect): void => {
        if (!component) return;
        const popupRect = component.element.getBoundingClientRect();
        const { top, left } = clampMentionPopupPosition(
          rect,
          { width: popupRect.width, height: popupRect.height },
          { width: window.innerWidth, height: window.innerHeight },
        );
        component.element.style.top = `${top}px`;
        component.element.style.left = `${left}px`;
      };

      const reposition = (clientRect: (() => (DOMRect | null)) | null | undefined): void => {
        if (!component) return;
        const rect = clientRect?.();
        if (!rect) return;
        applyPosition(rect);
        requestAnimationFrame(() => applyPosition(rect));
      };

      // "Mostrar todos" só faz sentido na visão de TOPO (query vazia, "os primeiros 5" do
      // diretório inteiro) — com um filtro digitado, a operadora já está buscando algo
      // específico, e "mostrar todos" ficaria ao lado de um resultado sem relação com ele (e
      // quebraria a contagem de itens de quem testa "digitar filtra para 1 resultado só").
      const showAllFor = (query: string): (() => Promise<StaffDirectoryEntry[]>) | undefined =>
        (loadAll && query.length === 0) ? loadAll : undefined;

      return {
        onStart: (props) => {
          // `ReactRenderer.element` é `HTMLElement` sempre (tipo da própria lib) — sem
          // `instanceof` redundante.
          component = new ReactRenderer(MentionPopupList, {
            props: { items: props.items, error: lastDirectoryError, command: props.command, onShowAll: showAllFor(props.query) },
            editor: props.editor,
          });
          component.element.style.position = 'fixed';
          component.element.style.zIndex = '50';
          document.body.appendChild(component.element);
          reposition(props.clientRect);
        },
        onUpdate: (props) => {
          component?.updateProps({ items: props.items, error: lastDirectoryError, command: props.command, onShowAll: showAllFor(props.query) });
          reposition(props.clientRect);
        },
        // Escape já é tratado pelo próprio `Suggestion` plugin (sempre fecha, `dispatchExit`)
        // ANTES de chamar este `onKeyDown` — só ArrowUp/ArrowDown/Enter chegam aqui de fato
        // (commit 3, teclado + ARIA). Delegado ao `ref` do popup: o foco nunca sai do editor.
        onKeyDown: ({ event }) => component?.ref?.onKeyDown({ event }) ?? false,
        onExit: () => {
          component?.element.remove();
          component?.destroy();
          component = null;
        },
      };
    },
  };
}
