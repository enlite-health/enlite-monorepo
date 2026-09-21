/**
 * MessageAttachments — chips/miniaturas de anexo de UMA mensagem já enviada (Bloco 3, T321;
 * ajustes de UI B5 — extraído de `ThreadView.tsx` para caber no teto de 400 linhas do arquivo, e
 * upgradado com nome+tamanho, D-02 revisto: a listagem agora decifra `originalName` também).
 *
 * IMAGEM (png/jpeg) → miniatura inline (`ImageAttachment`, lazy por `IntersectionObserver`).
 * PDF/DOCX → chip com ícone + nome (truncado) + tamanho, clique baixa (comportamento antigo).
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminConversationApiService, type ConversationMessageAttachment } from '@infrastructure/http/AdminConversationApiService';
import { Text } from '@presentation/components/atoms/Text';
import { Download } from 'lucide-react';
import { iconComponentForContentType, extensionForContentType, formatFileSize, isImageContentType } from './attachmentIcon';

/**
 * Abre a signed URL de DOWNLOAD (attachment forçado pelo backend, D-02) numa aba nova.
 *
 * 🔒 A ABA TEM DE ABRIR NO MESMO TICK DO CLIQUE / SEM `noopener`/`noreferrer` NO `window.open` /
 * fecha sozinha depois de um tempo fixo — os 3 achados de `evidencias/*` (e2e Playwright, sessão
 * do Bloco 3) que já fecharam esta função ANTES da extração; comportamento idêntico, só movido de
 * arquivo. Ver histórico completo em `ThreadView.tsx` (git blame) se precisar do relato inteiro.
 */
function useAttachmentDownload(patientId: string): {
  downloadError: string | null;
  handleDownload: (fileId: string) => Promise<void>;
} {
  const { t } = useTranslation();
  const td = (key: string, fallback: string): string => t(`admin.patients.detail.conversation.thread.${key}`, fallback);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleDownload = useCallback(async (fileId: string): Promise<void> => {
    setDownloadError(null);
    const popup = window.open('', '_blank');
    if (!popup) {
      setDownloadError(
        td('attachments.popupBlocked', 'Tu navegador bloqueó la ventana emergente. Habilitá los pop-ups para descargar el archivo.'),
      );
      return;
    }
    popup.opener = null;
    try {
      const { url } = await AdminConversationApiService.getConversationAttachmentUrl(patientId, fileId);
      popup.location.href = url;
      window.setTimeout(() => {
        if (!popup.closed) popup.close();
      }, 2000);
    } catch {
      popup.close();
      setDownloadError(td('attachments.downloadError', 'Não conseguimos baixar o arquivo. Tente de novo.'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  return { downloadError, handleDownload };
}

interface ImageAttachmentProps {
  patientId: string;
  attachment: ConversationMessageAttachment;
  onDownload: (fileId: string) => void;
}

/**
 * Miniatura de imagem — carrega a signed URL (mesmo endpoint de download, `GET .../files/:fileId/url`)
 * só quando o card FICA VISÍVEL (`IntersectionObserver`) e via `fetch` → `blob` → `URL.createObjectURL`
 * (nunca `<img src={signedUrl}>` cru): a signed URL não fica exposta no DOM/print de tela, e o
 * `objectURL` some no unmount (`revokeObjectURL`) — sem isto, uma conversa com muitas imagens
 * vazaria memória de blob a cada abertura/fechamento do painel.
 *
 * 🔒 Sem CSP configurada neste frontend (`grep -rn "Content-Security-Policy\|img-src"` — vazio em
 * toda a árvore, sem `dist`/`node_modules`) — `img-src` não é um risco aqui hoje; o `fetch`→`blob`
 * foi escolhido mesmo assim por ser MAIS testável (mock de `fetch`, sem depender do carregamento
 * de rede de um `<img>` em jsdom) e por nunca deixar a signed URL (300s, mas ainda assim um
 * segredo de curta duração) crua num atributo `src` que sobrevive em devtools/prints.
 */
function ImageAttachment({ patientId, attachment, onDownload }: ImageAttachmentProps): JSX.Element {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const name = attachment.originalName || extensionForContentType(attachment.contentType);

  useEffect(() => {
    const el = containerRef.current;
    // Ambiente sem IntersectionObserver (defesa em profundidade — nunca trava a miniatura escondida pra sempre).
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    let createdUrl: string | null = null;
    void (async (): Promise<void> => {
      try {
        const { url } = await AdminConversationApiService.getConversationAttachmentUrl(patientId, attachment.fileId);
        const response = await fetch(url);
        const blob = await response.blob();
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [visible, patientId, attachment.fileId]);

  return (
    <div
      ref={containerRef}
      data-testid={`message-attachment-${attachment.fileId}`}
      className="flex flex-col gap-1 max-w-[220px] min-w-0"
    >
      <div className="relative group rounded-md overflow-hidden border border-gray-300 bg-gray-200">
        {objectUrl && (
          <img
            src={objectUrl}
            alt={name}
            data-testid={`message-attachment-image-${attachment.fileId}`}
            className="w-full max-h-40 object-cover block"
          />
        )}
        {!objectUrl && (
          <div className="w-full h-24 flex items-center justify-center">
            <Text size="xs" className="text-gray-800">
              {loadError ? t('admin.patients.detail.conversation.thread.attachments.downloadError', 'Não conseguimos baixar o arquivo. Tente de novo.') : '…'}
            </Text>
          </div>
        )}
        {objectUrl && (
          <button
            type="button"
            data-testid={`message-attachment-download-${attachment.fileId}`}
            aria-label={t('admin.patients.detail.conversation.thread.attachments.download', 'Baixar anexo')}
            onClick={() => onDownload(attachment.fileId)}
            className="absolute inset-0 hidden group-hover:flex items-center justify-center bg-black/40"
          >
            <Download size={18} className="text-white" aria-hidden="true" />
          </button>
        )}
      </div>
      <span className="text-xs text-gray-800 truncate" title={name}>{name}</span>
    </div>
  );
}

interface FileChipProps {
  attachment: ConversationMessageAttachment;
  onDownload: (fileId: string) => void;
}

/**
 * 🔒 Chip de PDF/DOCX — COMPACTO, UMA linha (achado do gate visual, ajustes de UI B5, rodada 2):
 * antes, este `<button>` vivia no MESMO `flex flex-wrap` que `ImageAttachment` — flexbox estica
 * (`align-items: stretch`, default) todo item de uma LINHA para a altura do maior irmão da linha;
 * ao lado de uma miniatura de imagem (até 160px), o chip virava uma caixa ALTA e vazia com o
 * conteúdo flutuando no meio (`ui-ajustes-00-antes-depois.png`, lado direito, "sample.pdf 369 B").
 * Conserto: PDF/DOCX vive na PRÓPRIA lista (`flex flex-col`), nunca mais um irmão de flex-row de
 * uma miniatura — sem isso, qualquer `max-h`/`items-center` no botão não teria efeito nenhum
 * sobre o esticamento imposto pelo PAI.
 */
function FileChip({ attachment, onDownload }: FileChipProps): JSX.Element {
  const { t } = useTranslation();
  const td = (key: string, fallback: string): string => t(`admin.patients.detail.conversation.thread.${key}`, fallback);
  const Icon = iconComponentForContentType(attachment.contentType);
  const name = attachment.originalName || extensionForContentType(attachment.contentType);

  return (
    <button
      type="button"
      data-testid={`message-attachment-${attachment.fileId}`}
      aria-label={td('attachments.download', 'Baixar anexo')}
      title={name}
      onClick={() => onDownload(attachment.fileId)}
      className="flex items-center gap-1.5 text-xs text-primary hover:underline hover:bg-gray-100 max-w-[280px] min-w-0 border border-gray-300 rounded-md px-2 py-1 self-start"
    >
      <Icon size={14} aria-hidden="true" className="flex-shrink-0" />
      <span className="truncate">{name}</span>
      <span className="text-gray-800 flex-shrink-0">{formatFileSize(attachment.sizeBytes)}</span>
    </button>
  );
}

export function MessageAttachments({
  patientId, attachments,
}: { patientId: string; attachments: ConversationMessageAttachment[] }): JSX.Element | null {
  const { downloadError, handleDownload } = useAttachmentDownload(patientId);

  if (attachments.length === 0) return null;

  const images = attachments.filter((a) => isImageContentType(a.contentType));
  const files = attachments.filter((a) => !isImageContentType(a.contentType));
  const onDownload = (fileId: string): void => { void handleDownload(fileId); };

  return (
    <div data-testid="message-attachments" className="flex flex-col gap-2 mt-1">
      {/* Miniaturas de imagem — grade própria, nunca misturada com os chips (ver FileChip acima). */}
      {images.length > 0 && (
        <div data-testid="message-attachments-images" className="flex flex-wrap gap-2">
          {images.map((attachment) => (
            <ImageAttachment
              key={attachment.fileId}
              patientId={patientId}
              attachment={attachment}
              onDownload={onDownload}
            />
          ))}
        </div>
      )}
      {/* PDF/DOCX — lista compacta de UMA linha por item, abaixo das miniaturas. */}
      {files.length > 0 && (
        <div data-testid="message-attachments-files" className="flex flex-col gap-1">
          {files.map((attachment) => (
            <FileChip key={attachment.fileId} attachment={attachment} onDownload={onDownload} />
          ))}
        </div>
      )}
      {downloadError && (
        <Text size="xs" role="alert" className="text-red-600" data-testid="message-attachments-error">
          {downloadError}
        </Text>
      )}
    </div>
  );
}
