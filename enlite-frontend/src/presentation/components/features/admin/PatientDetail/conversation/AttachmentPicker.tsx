/**
 * AttachmentPicker — spec 022, Bloco 3 (T318/T319). Widget de anexo do compositor: campo +
 * validação de tamanho no CLIENTE + upload real (`AdminConversationApiService.uploadConversationAttachment`,
 * T206) + chip por arquivo enviado. Não conhece o `MessageComposer` por dentro (T319): só devolve
 * `onUploaded(fileId)`/`onRemoved(fileId)` — quem embrulha decide o que fazer com o array de ids.
 *
 * 🔒 VALIDAÇÃO DE TAMANHO NO CLIENTE (D-14, 10 MB) — antes de QUALQUER chamada de rede: subir um
 * arquivo de 10 MB só para o servidor recusar por `multer.limits.fileSize` desperdiça banda da
 * operadora à toa (rede de clínica/domicílio, muitas vezes 3G). O servidor continua sendo a
 * fronteira que decide de verdade (fail-closed) — esta checagem é só uma resposta mais rápida.
 *
 * 🔒 MÁXIMO 5 (contrato: `fileIds: z.array(z.string().uuid()).max(5)`) — contado pelos itens que
 * NÃO estão em erro (`status !== 'error'`): um upload recusado nunca ocupa vaga, senão a operadora
 * ficaria travada em "5 anexados" com 3 erros e 2 de verdade.
 *
 * 🔒 MAPEAMENTO DE ERRO — mesmas chaves i18n que T124 já criou (`errors.*`, paridade ES/PT
 * verificada): `FILE_TOO_LARGE`→`fileTooLarge`, `UNSUPPORTED_MEDIA_TYPE`→`unsupportedType`,
 * `MALICIOUS_CONTENT_DETECTED`→`maliciousContent`, `LEGACY_DOC_NOT_ALLOWED`→`legacyDoc`; qualquer
 * outra falha (rede, 500) cai no genérico `uploadFailed` (novo nesta task, mesmo padrão de
 * `sendFailed`) — nunca um `catch` mudo (regra do brief, mesmo achado que already fechou
 * `MessageComposer.handleSend`).
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminConversationApiService } from '@infrastructure/http/AdminConversationApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import { Text } from '@presentation/components/atoms/Text';
import { iconComponentForContentType } from './attachmentIcon';

/** D-14: extensões aceitas no CAMPO — a validação de CONTEÚDO (magic bytes) é sempre do servidor. */
const ACCEPTED_ATTACHMENT_TYPES = '.pdf,.png,.jpg,.jpeg,.docx';
/** D-14: mesmo limite do backend (`ConversationAttachmentPolicy.MAX_ATTACHMENT_BYTES`) — checagem
 * no cliente é resposta rápida, o servidor é quem decide de verdade (fail-closed). */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Contrato: `POST .../conversation/messages` recusa `fileIds` com mais de 5 (`z.array(...).max(5)`). */
const MAX_ATTACHMENTS = 5;

type AttachmentStatus = 'uploading' | 'done' | 'error';

interface AttachmentItem {
  localId: string;
  file: File;
  status: AttachmentStatus;
  fileId?: string;
  errorMessage?: string;
}

export interface AttachmentPickerProps {
  patientId: string;
  /** Chamado UMA VEZ por upload bem-sucedido, com o `fileId` que o POST de mensagem espera em `fileIds[]`. */
  onUploaded: (fileId: string) => void;
  /** Chamado quando um anexo JÁ ENVIADO é removido ANTES do envio da mensagem — opcional (quem não
   * remove nada nunca precisa dele). */
  onRemoved?: (fileId: string) => void;
  /**
   * 🔒 Achado do gate revisao-pr (B3, defeito MÉDIO): dispara `true`/`false` a cada mudança de
   * "há algum item `status==='uploading'`" — quem embrulha (`MessageComposer`) usa para desabilitar
   * o botão de enviar ENQUANTO houver upload em andamento. Sem isto, um envio no meio de um upload
   * pendente disparava `clearDraft()` (remonta este componente via `key`) e o `onUploaded` do
   * upload órfão, quando resolvia depois, ainda rodava — o `fileId` entrava no rascunho NOVO,
   * invisível, e era anexado à PRÓXIMA mensagem sem o operador ver.
   */
  onUploadingChange?: (isUploading: boolean) => void;
  disabled?: boolean;
}

let localIdSeq = 0;
function nextLocalId(): string {
  localIdSeq += 1;
  return `attachment-${localIdSeq}`;
}

/** Código de erro do servidor (D-14) → chave i18n já criada por T124 (`errors.*`). */
function errorKeyFor(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'FILE_TOO_LARGE': return 'fileTooLarge';
      case 'UNSUPPORTED_MEDIA_TYPE': return 'unsupportedType';
      case 'MALICIOUS_CONTENT_DETECTED': return 'maliciousContent';
      case 'LEGACY_DOC_NOT_ALLOWED': return 'legacyDoc';
      default: return 'uploadFailed';
    }
  }
  return 'uploadFailed';
}

export function AttachmentPicker({
  patientId, onUploaded, onRemoved, onUploadingChange, disabled,
}: AttachmentPickerProps): JSX.Element {
  const { t } = useTranslation();
  const tc = (key: string): string => t(`admin.patients.detail.conversation.composer.${key}`);
  const te = (key: string): string => t(`admin.patients.detail.conversation.errors.${key}`);

  const [items, setItems] = useState<AttachmentItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * 🔒 Guarda de desmontagem (achado do gate revisao-pr, B3): `MessageComposer.clearDraft()`
   * troca a `key` deste componente para forçar uma REMONTAGEM (perder os chips) — mas a promise
   * de um `uploadOne` em voo na instância ANTIGA continua rodando no event loop; sem esta guarda,
   * ela chamaria `onUploaded`/`setItems` numa instância já desmontada quando resolvesse (o
   * `fileId` vazaria para o rascunho da PRÓXIMA mensagem, silenciosamente, e o React acusaria
   * "state update on an unmounted component").
   */
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const activeCount = items.filter((it) => it.status !== 'error').length;
  const atMax = activeCount >= MAX_ATTACHMENTS;

  useEffect(() => {
    onUploadingChange?.(items.some((it) => it.status === 'uploading'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const uploadOne = useCallback(async (localId: string, file: File): Promise<void> => {
    try {
      const result = await AdminConversationApiService.uploadConversationAttachment(patientId, file);
      if (!isMountedRef.current) return; // instância antiga (remontada por key) — upload órfão, não vaza
      setItems((prev) => prev.map((it) => (it.localId === localId ? { ...it, status: 'done', fileId: result.fileId } : it)));
      onUploaded(result.fileId);
    } catch (err) {
      if (!isMountedRef.current) return;
      setItems((prev) => prev.map((it) => (
        it.localId === localId ? { ...it, status: 'error', errorMessage: te(errorKeyFor(err)) } : it
      )));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId, onUploaded]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite re-selecionar o MESMO arquivo depois (ex.: após remover um erro)
    if (!file || atMax) return;

    const localId = nextLocalId();
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setItems((prev) => [...prev, { localId, file, status: 'error', errorMessage: te('fileTooLarge') }]);
      return;
    }

    setItems((prev) => [...prev, { localId, file, status: 'uploading' }]);
    void uploadOne(localId, file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atMax, uploadOne]);

  const handleRemove = useCallback((localId: string): void => {
    setItems((prev) => {
      const target = prev.find((it) => it.localId === localId);
      if (target?.status === 'done' && target.fileId) onRemoved?.(target.fileId);
      return prev.filter((it) => it.localId !== localId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRemoved]);

  return (
    <div data-testid="attachment-picker" className="flex flex-col gap-1.5">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_ATTACHMENT_TYPES}
        data-testid="composer-attach-input"
        onChange={handleChange}
        className="hidden"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="composer-attach-btn"
          aria-label={tc('attach')}
          disabled={disabled || atMax}
          onClick={() => inputRef.current?.click()}
          className="text-sm text-gray-500 hover:text-primary disabled:opacity-50 disabled:hover:text-gray-500"
        >
          {tc('attach')}
        </button>
        {atMax && (
          <Text size="xs" className="text-gray-400" data-testid="attachment-picker-max">
            {tc('attachments.max')}
          </Text>
        )}
      </div>

      {items.length > 0 && (
        <ul data-testid="attachment-picker-list" className="flex flex-col gap-1">
          {items.map((item) => (
            <li
              key={item.localId}
              data-testid={`attachment-chip-${item.localId}`}
              className="flex items-center gap-2 text-xs text-gray-600"
            >
              {(() => {
                const Icon = iconComponentForContentType(item.file.type);
                return <Icon size={14} aria-hidden="true" />;
              })()}
              <span data-testid="attachment-chip-name">{item.file.name}</span>
              {item.status === 'uploading' && (
                <Text size="xs" className="text-gray-400" data-testid="attachment-chip-uploading">
                  {tc('attachments.uploading')}
                </Text>
              )}
              {item.status === 'error' && (
                <Text size="xs" role="alert" className="text-red-600" data-testid="attachment-chip-error">
                  {item.errorMessage}
                </Text>
              )}
              <button
                type="button"
                data-testid={`attachment-chip-remove-${item.localId}`}
                aria-label={tc('attachments.remove')}
                onClick={() => handleRemove(item.localId)}
                className="text-gray-400 hover:text-gray-700"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
