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
  forwardRef, useCallback, useImperativeHandle, useRef, useState, type JSX,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor, EditorContent } from '@tiptap/react';
import { Document } from '@tiptap/extension-document';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Text as TiptapText } from '@tiptap/extension-text';
import { HardBreak } from '@tiptap/extension-hard-break';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Mention } from '@tiptap/extension-mention';
import {
  AdminConversationApiService,
  type CreateConversationMessageResult,
} from '@infrastructure/http/AdminConversationApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import { useConfirmDiscardClose } from '@hooks/admin/useConfirmDiscardClose';
import { useStaffDirectoryStore } from '@presentation/stores/staffDirectoryStore';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';
import { configureMentionSuggestion } from '@presentation/components/features/mentions/createMentionSuggestion';
import { mentionChipRenderText, mentionChipRenderHTML } from '@presentation/components/features/mentions/mentionChip';
import { AttachmentPicker } from './AttachmentPicker';

/** `q` ausente/vazio agora é aceito pelo backend (item 1, revoga D-06) — `0` deixa o TipTap
 * chamar `items()` a partir do próprio `@`, sem exigir nenhum caractere depois. */
const MENTION_MIN_QUERY_LENGTH = 0;
/** Popup estilo ClickUp (Rodada 2, decisão do Gabriel 22/09): "os primeiros ~5 + Mostrar todos" —
 * não é mais o teto de exibição do diretório inteiro (`MAX_STAFF_DIRECTORY_RESULTS`, backend),
 * é o corte da VISÃO DE TOPO; "Mostrar todos" (via `staffDirectoryStore.loadAll`) é quem busca a
 * lista inteira, até o teto do backend (200). */
const MENTION_MAX_RESULTS = 5;

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

    // 🔒 `useEditor` monta com deps `[]` (a extensão do TipTap não pode ser recriada a cada
    // render — perderia o estado do documento). `patientId` é lido dentro do `suggestion` do
    // `Mention`, que é fechado UMA VEZ nesse mount — sem o ref, um `MessageComposer` que
    // trocasse de paciente sem desmontar (ex.: painel reaproveitado entre fichas) ficaria preso
    // no `patientId` da 1ª renderização (bug silencioso: filtraria pela conversa ERRADA, nunca a
    // atual). O ref sempre reflete a prop mais recente sem re-configurar o editor inteiro.
    const patientIdRef = useRef(patientId);
    patientIdRef.current = patientId;

    const editor = useEditor({
      extensions: [
        Document,
        Paragraph,
        TiptapText,
        HardBreak,
        Placeholder.configure({ placeholder: tc('placeholder') }),
        Mention.configure({
          renderText: mentionChipRenderText,
          renderHTML: mentionChipRenderHTML,
          // `staffDirectoryStore` (Rodada 2) é a fonte injetada — `search`/`loadAll` já alimentam
          // o `staffNameCache` por dentro (fix-once: antes esse `remember` vivia aqui via
          // `onResults`; virou duplicação em potencial no dia em que "Mostrar todos" (`loadAll`)
          // passou a ser uma 2ª fonte de resultados fora do `items()` do TipTap).
          // Rodada 3/R3-F: `patientId` (já uma prop deste componente — vem de
          // `PatientConversationHandle`/`ConversationPanel`, sem nenhuma árvore nova) é repassado
          // ao `staffDirectoryStore` — é ele quem decide se manda ao backend (contrato novo R3-1).
          // O módulo `createMentionSuggestion` continua genérico: nunca conhece `patientId`, só
          // recebe as closures já fechadas sobre ele (quem injeta a fonte é o chamador).
          suggestion: configureMentionSuggestion({
            fetchCandidates: (query) => useStaffDirectoryStore.getState().search(query, patientIdRef.current),
            loadAll: () => useStaffDirectoryStore.getState().loadAll(patientIdRef.current),
            minQueryLength: MENTION_MIN_QUERY_LENGTH,
            maxResults: MENTION_MAX_RESULTS,
          }),
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
