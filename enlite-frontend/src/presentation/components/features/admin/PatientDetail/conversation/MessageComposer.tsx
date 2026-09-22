/**
 * MessageComposer — spec 022, Bloco 2 (T215/T216). Campo de escrita da conversa do paciente:
 * TipTap (`@tiptap/react`) + `@tiptap/extension-mention` para `@` + autocomplete de staff.
 *
 * 🔒 POR QUE TIPTAP E NÃO `<textarea>` (`research.md` §1). A menção precisa de um CHIP visual
 * ("@QA Staff Um") enquanto o valor que vai ao servidor é `<@uid>` — dois textos diferentes para
 * o mesmo nó. `TemplateComposerEditor.tsx` resolve o mesmo problema (rótulo amigável vs. token)
 * com `contenteditable` cru; a decisão da spec 022 é usar TipTap aqui, então NÃO copiamos aquele
 * componente — a resolução do texto que sai (`<@uid>`) usa o ponto de extensão do próprio TipTap
 * (`Mention.renderText`, que o `editor.getText()` já respeita via `schema.toText`), em vez de um
 * serializador de DOM escrito à mão.
 *
 * 🔒 MIN 0 CARACTERES ANTES DE BUSCAR (change 022-ux-mencao-e-notificacao, item 1 — revoga D-06,
 * `fatos-medidos.md` F1/F2). Antes exigia 2+ caracteres (`contracts/openapi-staff-directory.md`
 * linha 10 dizia `q` era `min(2)`); o backend agora aceita `q` ausente/vazio (`staffDirectorySchema`
 * revisado) e devolve os primeiros N do diretório — `minQueryLength: 0` só habilita o TipTap a
 * CHAMAR `items()` com a query vazia, a mesma função que já buscava com texto.
 *
 * 🔒 POPUP ANCORADO NO CURSOR (F4): antes o elemento era só `document.body.appendChild` sem ler
 * posição nenhuma (nascia em `(0,0)`). Agora lê `props.clientRect()` (posição real do cursor no
 * editor, que o próprio TipTap calcula) e usa `clampMentionPopupPosition` (aritmética pura,
 * testada à parte) para nunca deixar o popup nascer fora do viewport — sem lib de posicionamento
 * nova (Popper/Floating UI), design.md §1.
 *
 * 🔒 ANEXO É UPLOAD REAL (D-14, Bloco 3, T320) — `AttachmentPicker` (T318/T319) faz o upload e a
 * validação de conteúdo/tamanho; este componente só acumula os `fileId`s que ele confirma
 * (`onUploaded`/`onRemoved`) e os inclui no `fileIds` do POST de mensagem. Nunca conhece o
 * `<input type=file>` por dentro — delega inteiro ao picker (fix-once, zero duplicação).
 *
 * 🔒 DESCARTE (`useConfirmDiscardClose`, hook já existente — não duplicado). Este componente NÃO
 * conhece o `SlideOverPanel` que o embrulha (isso é outro agente); expõe `requestClose` via
 * `ref` para quem quiser perguntar antes de fechar. Chamado direto: fecha sem perguntar se o
 * rascunho está vazio; com rascunho, abre a confirmação AQUI DENTRO (nunca fecha silenciosamente).
 */
import {
  forwardRef, useCallback, useImperativeHandle, useState, type JSX,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor, EditorContent, ReactRenderer } from '@tiptap/react';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text as TiptapText } from '@tiptap/extension-text';
import { HardBreak } from '@tiptap/extension-hard-break';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Mention } from '@tiptap/extension-mention';
import {
  AdminConversationApiService,
  type CreateConversationMessageResult,
  type StaffDirectoryEntry,
} from '@infrastructure/http/AdminConversationApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import { useConfirmDiscardClose } from '@hooks/admin/useConfirmDiscardClose';
import { useStaffNameCache } from '@presentation/stores/staffNameCache';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';
import { AttachmentPicker } from './AttachmentPicker';
import { clampMentionPopupPosition } from './mentionPopupPosition';

/** `q` ausente/vazio agora é aceito pelo backend (item 1, revoga D-06) — `0` deixa o TipTap
 * chamar `items()` a partir do próprio `@`, sem exigir nenhum caractere depois. */
const MENTION_MIN_QUERY_LENGTH = 0;
const MENTION_MAX_RESULTS = 20;

export interface MessageComposerHandle {
  /** true se há rascunho (texto OU anexo) não vazio — quem embrulha usa para decidir se pergunta
   * antes de qualquer outra ação própria, sem precisar reimplementar a régua de "vazio". */
  isDirty: () => boolean;
  /** Pede para fechar. Rascunho vazio: fecha direto (chama `onClose`). Rascunho não vazio: abre
   * a confirmação de descarte DENTRO deste componente — só chama `onClose` se confirmado. */
  requestClose: () => void;
}

export interface MessageComposerProps {
  patientId: string;
  /** Presente quando o compositor está numa THREAD (reply); ausente = mensagem de topo. */
  rootMessageId?: string;
  /** Chamado com o resultado do POST bem-sucedido — quem usa decide se recarrega a lista. */
  onSent?: (result: CreateConversationMessageResult) => void;
  /** Chamado quando o rascunho pode ser perdido de verdade (vazio, ou descarte confirmado). */
  onClose?: () => void;
}

interface MentionListProps {
  items: StaffDirectoryEntry[];
  /** `true` quando a última chamada ao diretório falhou (rede/403/500) — distinto de "0
   * resultados de verdade" (F5, item 1). `items` some `[]` nos dois casos; só este flag diferencia. */
  error: boolean;
  command: (attrs: { id: string; label: string }) => void;
}

/** Popup do autocomplete de menção — renderizado via `ReactRenderer` fora da árvore React normal
 * (é assim que o `suggestion.render` do TipTap funciona), mas é um componente React comum.
 *
 * 🔒 Estado de erro (F5, item 1): antes, falha do diretório virava `[]` — indistinguível de "sem
 * resultado", e o popup simplesmente sumia (mentindo "não achei nada" quando na verdade não deu
 * pra perguntar). Agora `error` mostra uma linha discreta, nunca um crash, nunca um toast
 * (autocomplete continua não sendo canal de alerta — só deixa de mentir). */
function MentionList({ items, error, command }: MentionListProps): JSX.Element | null {
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
    <ul data-testid="composer-mention-list" className="rounded-md border bg-white shadow-md py-1">
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

export const MessageComposer = forwardRef<MessageComposerHandle, MessageComposerProps>(
  function MessageComposer({ patientId, rootMessageId, onSent, onClose }, ref): JSX.Element {
    const { t } = useTranslation();
    const tc = (key: string): string => t(`admin.patients.detail.conversation.composer.${key}`);
    const te = useCallback(
      (key: string): string => t(`admin.patients.detail.conversation.errors.${key}`),
      [t],
    );

    const [isEmpty, setIsEmpty] = useState(true);
    const [fileIds, setFileIds] = useState<string[]>([]);
    /** Muda a cada `clearDraft()` — força o `AttachmentPicker` a REMONTAR (perde os chips e o
     * contador interno de "5 no máximo"), já que ele é quem dono do estado visual dos anexos
     * (T319: "não conhece o MessageComposer por dentro"). Sem isto, um envio bem-sucedido limpava
     * `fileIds` aqui mas os chips ficavam na tela — a operadora reenviaria o mesmo anexo sem saber. */
    const [attachmentPickerResetKey, setAttachmentPickerResetKey] = useState(0);
    const [sendError, setSendError] = useState<string | null>(null);
    /** 🔒 Achado do gate revisao-pr (B3): enviar DURANTE um upload em andamento perdia o `fileId`
     * de um upload que terminava DEPOIS de `clearDraft()` já ter remontado o `AttachmentPicker` —
     * ver `AttachmentPicker.onUploadingChange`. */
    const [isUploading, setIsUploading] = useState(false);

    // Closure compartilhada entre `items()` e `render()` do `suggestion` do TipTap (item 1, F5) —
    // ver comentário em `items()` abaixo. Vive fora de `useState` de propósito: não deve causar
    // re-render do `MessageComposer`, só é lido pelo próprio popup (componente React separado,
    // fora desta árvore) no instante em que `onStart`/`onUpdate` disparam.
    let lastDirectoryError = false;

    const editor = useEditor({
      extensions: [
        Document,
        Paragraph,
        TiptapText,
        HardBreak,
        Placeholder.configure({ placeholder: tc('placeholder') }),
        Mention.configure({
          renderText: ({ node }) => `<@${node.attrs.id}>`,
          renderHTML: ({ node }) => [
            'span',
            {
              'data-testid': 'composer-mention-chip',
              'data-id': node.attrs.id,
              class: 'inline-block px-1.5 py-0.5 mx-0.5 rounded bg-primary/10 text-primary text-sm',
            },
            `@${node.attrs.label ?? node.attrs.id}`,
          ],
          suggestion: {
            char: '@',
            minQueryLength: MENTION_MIN_QUERY_LENGTH,
            items: async ({ query }: { query: string }): Promise<StaffDirectoryEntry[]> => {
              try {
                const results = await AdminConversationApiService.searchStaffDirectory(query);
                // Achado baixo do gate do B2 (`ThreadView` mostrava uid cru): esta é a ÚNICA fonte
                // real de nome que o front tem hoje (contrato não resolve uid → nome) — todo staff
                // que aparece aqui fica disponível pro `useStaffDisplayName` de qualquer mensagem
                // dele nesta conversa, não só para o item escolhido.
                useStaffNameCache.getState().remember(results);
                lastDirectoryError = false;
                return results.slice(0, MENTION_MAX_RESULTS);
              } catch {
                // F5/item 1: falha vira `[]` (autocomplete não é canal de alerta — nunca crash),
                // mas `lastDirectoryError` (closure compartilhada com `render()` abaixo, mesma
                // chamada de `Mention.configure`) deixa o popup MOSTRAR que falhou, em vez de
                // mentir "nenhum resultado" — TipTap resolve `items()` ANTES de chamar
                // `onStart`/`onUpdate` com o resultado, então a flag já está atualizada a tempo.
                lastDirectoryError = true;
                return [];
              }
            },
            render: () => {
              let component: ReactRenderer<unknown, MentionListProps> | null = null;

              const reposition = (clientRect: (() => (DOMRect | null)) | null | undefined): void => {
                if (!component) return;
                const rect = clientRect?.();
                if (!rect) return;
                const popupRect = component.element.getBoundingClientRect();
                const { top, left } = clampMentionPopupPosition(
                  rect,
                  { width: popupRect.width, height: popupRect.height },
                  { width: window.innerWidth, height: window.innerHeight },
                );
                component.element.style.top = `${top}px`;
                component.element.style.left = `${left}px`;
              };

              return {
                onStart: (props) => {
                  component = new ReactRenderer(MentionList, {
                    props: { items: props.items, error: lastDirectoryError, command: props.command },
                    editor: props.editor,
                  });
                  // `ReactRenderer.element` é `HTMLElement` sempre (tipo da própria lib) —
                  // sem `instanceof` redundante.
                  component.element.style.position = 'fixed';
                  component.element.style.zIndex = '50';
                  document.body.appendChild(component.element);
                  reposition(props.clientRect);
                },
                onUpdate: (props) => {
                  component?.updateProps({ items: props.items, error: lastDirectoryError, command: props.command });
                  reposition(props.clientRect);
                },
                onKeyDown: ({ event }) => event.key === 'Escape',
                onExit: () => {
                  component?.element.remove();
                  component?.destroy();
                  component = null;
                },
              };
            },
          },
        }),
      ],
      editorProps: {
        attributes: {
          'data-testid': 'composer-editor',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': tc('placeholder'),
          class: 'min-h-[44px] max-h-[160px] overflow-y-auto px-3 py-2 text-sm outline-none',
        },
      },
      onUpdate: ({ editor: current }) => {
        setIsEmpty(current.getText().trim().length === 0);
        setSendError(null); // corrigir o rascunho depois de um erro esconde o aviso antigo
      },
    }, []);

    const clearDraft = useCallback((): void => {
      editor?.commands.clearContent(true);
      setIsEmpty(true);
      setFileIds([]);
      setAttachmentPickerResetKey((n) => n + 1);
    }, [editor]);

    const handleConfirmedClose = useCallback((): void => {
      clearDraft();
      onClose?.();
    }, [clearDraft, onClose]);

    const isDirty = !isEmpty || fileIds.length > 0;

    const { confirmingClose, requestClose, keepEditing, confirmDiscard } = useConfirmDiscardClose({
      isDirty,
      onConfirmedClose: handleConfirmedClose,
    });

    useImperativeHandle(ref, () => ({
      isDirty: () => isDirty,
      requestClose,
    }), [isDirty, requestClose]);

    const handleSend = useCallback(async (): Promise<void> => {
      if (!editor) return;
      // Sem checagem redundante de "corpo vazio" aqui: o botão (`disabled={isEmpty}`, testado em
      // "enviar mensagem vazia é bloqueado") já é o único caminho até este handler, e `isEmpty`
      // É `editor.getText().trim().length === 0` — duplicar a checagem criaria um branch morto
      // (nunca alcançável por este handler, só por chamada direta que não existe).
      const body = editor.getText().trim();
      setSendError(null);
      try {
        const result = await AdminConversationApiService.postConversationMessage(patientId, {
          body,
          rootMessageId,
          fileIds: fileIds.length > 0 ? fileIds : undefined,
        });
        clearDraft();
        onSent?.(result);
      } catch (err) {
        // 🔒 DEFEITO ALTO do gate do B2 (`b2-gate-pr.md`, achado nº 1): sem este `catch`, um 403
        // (quem só tem `patient_conversation:read`) rejeitava a promise em silêncio — nada
        // aparecia na tela e a operadora achava que enviou. O rascunho NUNCA é perdido aqui: só
        // `clearDraft()` (acima, no caminho de sucesso) o apaga.
        setSendError(
          err instanceof ApiError && err.status === 403 ? te('sendForbidden') : te('sendFailed'),
        );
      }
    }, [editor, patientId, rootMessageId, fileIds, clearDraft, onSent, te]);

    const handleAttachmentUploaded = useCallback((fileId: string): void => {
      setFileIds((prev) => [...prev, fileId]);
    }, []);

    const handleAttachmentRemoved = useCallback((fileId: string): void => {
      setFileIds((prev) => prev.filter((id) => id !== fileId));
    }, []);

    const handleUploadingChange = useCallback((uploading: boolean): void => {
      setIsUploading(uploading);
    }, []);

    // `flex-shrink-0`: quando montado dentro do `flex flex-col` do painel (`ConversationPanel`/
    // `ThreadView`), o compositor NUNCA pode ser espremido pelo item do meio — achado "Enviar
    // cortado embaixo" (ajustes de UI B5): o culpado real era `min-h-0` faltando na lista rolável
    // (flex item sem isso não encolhe, e o excesso ia pro rodapé, cortado pela altura fixa do
    // painel); este `flex-shrink-0` é defesa em profundidade, não o conserto principal.
    return (
      <div data-testid="message-composer" className="border-t bg-white p-2 flex flex-col gap-2 flex-shrink-0">
        {confirmingClose && (
          <div
            data-testid="composer-discard-confirm"
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
          >
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6 flex flex-col gap-4">
              <p className="text-sm">{tc('discardConfirm')}</p>
              <div className="flex justify-end gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={keepEditing}
                  data-testid="composer-discard-cancel"
                >
                  {tc('cancel')}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={confirmDiscard}
                  data-testid="composer-discard-confirm-btn"
                >
                  {tc('discard')}
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className="rounded-md border">
          <EditorContent editor={editor} />
        </div>

        {sendError && (
          <Text size="xs" role="alert" className="text-red-600" data-testid="composer-send-error">
            {sendError}
          </Text>
        )}

        <AttachmentPicker
          key={attachmentPickerResetKey}
          patientId={patientId}
          onUploaded={handleAttachmentUploaded}
          onRemoved={handleAttachmentRemoved}
          onUploadingChange={handleUploadingChange}
        />

        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="primary"
            size="sm"
            data-testid="composer-send-btn"
            disabled={isEmpty || isUploading}
            onClick={handleSend}
          >
            {tc('send')}
          </Button>
        </div>
      </div>
    );
  },
);
