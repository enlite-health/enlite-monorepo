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
 *
 * 🔒 FECHAR (D1, achado do Gabriel 22/09) — dois defeitos medidos, dois consertos independentes:
 *
 * 1. CLICAR FORA não fechava: `render()` nunca chamava `props.mount()` — o próprio elemento era
 *    só `document.body.appendChild` + posição manual (`applyPosition`). O `dismissOnOutsideClick`
 *    (default `true` da lib) só existe DENTRO do `mount()` (ver `@tiptap/suggestion` `createMount`,
 *    "Only applies when using managed mounting via SuggestionProps.mount"). Conserto: chamar
 *    `props.mount(component.element, { onPosition: () => {} })` (o "escape hatch" documentado no
 *    próprio `.d.ts`) e guardar o `unmount` pra chamar em `onExit`. O `onPosition` no-op é o que
 *    faz o `mount()` ficar só responsável pelo listener de outside-click — ele PULA de escrever
 *    `style.left/top` sozinho quando `onPosition` está presente (ver source), então a posição
 *    continua 100% da nossa aritmética (`clampMentionPopupPosition`), sem duplicar/brigar com o
 *    Floating UI. Como já fazemos `appendChild` ANTES de chamar `mount()`, `element.isConnected`
 *    já é `true` quando ele roda — o `mount()` não re-anexa nem tenta remover sozinho (seguimos
 *    donos do DOM node, como sempre).
 *
 * 2. ESCAPE fechava o popup (o próprio `Suggestion` plugin já despacha o `exit` ANTES de chamar
 *    este `onKeyDown`), mas o evento nativo `keydown` nunca tinha `stopPropagation()` — só
 *    `preventDefault()` (feito pelo ProseMirror). Ele continuava borbulhando até `document`, onde
 *    o `SlideOverPanel` que embrulha este composer em produção (`PatientConversationHandle.tsx`)
 *    tem seu PRÓPRIO listener de Escape (`onKeyDown` no painel/drawer) — com o rascunho não vazio
 *    (o `@` já digitado conta), isso abria a confirmação de DESCARTE por cima do popup, em vez de
 *    só fechar o autocomplete. Conserto: `event.stopPropagation()` no `onKeyDown` deste módulo,
 *    ANTES de delegar ao `ref` do popup — contido aqui (é uma questão de propagação de DOM do
 *    `render()`, não do componente `MentionPopupList`, que continua testável isolado sem saber
 *    de Escape). Não precisa reabrir/impedir reabertura: o `dismissedRange` do próprio `Suggestion`
 *    plugin já resolve isso de graça (mesma posição não reabre; um `@` novo, posição nova, abre).
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
      // D1: cleanup do `props.mount()` (outside-click) — chamado em `onExit`, junto do resto do
      // teardown. `null` fora do ciclo ativo (antes de `onStart`, ou já limpo por `onExit`).
      let unmountOutsideClick: (() => void) | null = null;

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

      // Rodada 3/R3-F (item 2): "ninguém pode ser mencionado" só é uma leitura honesta quando a
      // busca não tinha filtro nenhum (`query === ''`) — com texto digitado, 0 resultados só
      // significa "não bateu com ESTA busca", nunca "não há candidato nenhum" (preserva o
      // silêncio antigo desse caso, `MentionPopupList` só troca de comportamento com o flag).
      const isEmptyState = (query: string, resultItems: StaffDirectoryEntry[]): boolean =>
        !lastDirectoryError && query.length === 0 && resultItems.length === 0;

      return {
        onStart: (props) => {
          // `ReactRenderer.element` é `HTMLElement` sempre (tipo da própria lib) — sem
          // `instanceof` redundante.
          component = new ReactRenderer(MentionPopupList, {
            props: {
              items: props.items,
              error: lastDirectoryError,
              command: props.command,
              onShowAll: showAllFor(props.query),
              emptyState: isEmptyState(props.query, props.items),
            },
            editor: props.editor,
          });
          component.element.style.position = 'fixed';
          component.element.style.zIndex = '50';
          document.body.appendChild(component.element);
          reposition(props.clientRect);
          // D1: `onPosition` no-op — `mount()` só assume o listener de outside-click; a posição
          // continua 100% de `reposition`/`clampMentionPopupPosition` (ver docblock do arquivo).
          unmountOutsideClick = props.mount(component.element, { onPosition: () => {} });
        },
        onUpdate: (props) => {
          component?.updateProps({
            items: props.items,
            error: lastDirectoryError,
            command: props.command,
            onShowAll: showAllFor(props.query),
            emptyState: isEmptyState(props.query, props.items),
          });
          reposition(props.clientRect);
        },
        // Escape já é tratado pelo próprio `Suggestion` plugin (sempre fecha, `dispatchExit`)
        // ANTES de chamar este `onKeyDown` — só ArrowUp/ArrowDown/Enter chegam aqui de fato
        // (commit 3, teclado + ARIA), FORA do Escape. Delegado ao `ref` do popup: o foco nunca
        // sai do editor.
        //
        // D1: Escape ainda precisa de `stopPropagation()` aqui — sem isto, o `keydown` nativo
        // segue borbulhando até `document` e aciona o listener de Esc do drawer que embrulha o
        // composer em produção (`SlideOverPanel`), abrindo a confirmação de descarte por cima do
        // popup em vez de só fechá-lo (ver docblock do arquivo). `preventDefault()` (feito pelo
        // ProseMirror ao ver o `true` do `handleKeyDown`) NUNCA impede propagação — são coisas
        // diferentes.
        onKeyDown: ({ event }) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            return true;
          }
          return component?.ref?.onKeyDown({ event }) ?? false;
        },
        onExit: () => {
          unmountOutsideClick?.();
          unmountOutsideClick = null;
          component?.element.remove();
          component?.destroy();
          component = null;
        },
      };
    },
  };
}
