import { useCallback, useEffect, useRef, useState, type ReactNode, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AdminConversationApiService,
  type ConversationMessage,
  type ConversationMessageAttachment,
} from '@infrastructure/http/AdminConversationApiService';
import { useStaffDisplayName } from '@presentation/stores/staffNameCache';
import { Text } from '@presentation/components/atoms/Text';
import { iconComponentForContentType, extensionForContentType } from './attachmentIcon';

const MENTION_PATTERN = /<@([^>]+)>/g;

/** Chip de UMA menção confirmada — nome de exibição quando resolvível (`useStaffDisplayName`,
 * achado baixo do gate do B2: mostrava uid cru), com fallback pro próprio uid. Componente
 * separado (não só `<span>`) porque a resolução de nome usa um hook — `renderMessageBody` abaixo
 * é uma função pura, não pode chamar hook direto. */
function MentionChip({ uid }: { uid: string }): JSX.Element {
  const displayName = useStaffDisplayName(uid);
  return (
    <span
      data-testid="mention-chip"
      className="inline-block px-1.5 py-0.5 mx-0.5 rounded bg-primary/10 text-primary text-sm"
    >
      @{displayName}
    </span>
  );
}

/**
 * Corpo da mensagem com `<@uid>` renderizado como CHIP. `mentions` chega do backend como a lista
 * de uids CONFIRMADOS (`ConversationRepository.fetchMentionsByMessageIds`) — em ORDEM ALFABÉTICA
 * do uid, não na ordem em que os tokens foram digitados no texto (decisão do B1). Por isso o
 * casamento é por UID — o próprio valor já está dentro do token (`<@uid>`, capturado em
 * `match[1]`) — e NUNCA por posição/índice: com 2+ menções, a ordem alfabética e a ordem de
 * digitação divergem, e casar pelo índice trocava o rótulo entre elas (achado real, spec 022 B2 —
 * numa conversa clínica, atribuía a cobrança à pessoa errada). `mentions` funciona como o
 * conjunto de uids CONFIRMADOS pelo servidor: um token com a forma `<@x>` que não está nesse
 * conjunto cai pro texto cru, sem chip (nunca quebra a tela, mas também nunca finge confirmação
 * que o servidor não deu).
 *
 * Exportada porque `ConversationPanel.tsx` reaproveita — MESMA regra de renderização nos dois
 * lugares (mensagem de topo e reply), sem duplicar a lógica de parsing.
 */
export function renderMessageBody(body: string, mentions: readonly string[]): ReactNode[] {
  const confirmedUids = new Set(mentions);
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  MENTION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = MENTION_PATTERN.exec(body);
  while (match !== null) {
    if (match.index > lastIndex) parts.push(body.slice(lastIndex, match.index));
    const uid = match[1];
    if (confirmedUids.has(uid)) {
      parts.push(<MentionChip key={`mention-${match.index}`} uid={uid} />);
    } else {
      parts.push(body.slice(match.index, match.index + match[0].length));
    }
    lastIndex = match.index + match[0].length;
    match = MENTION_PATTERN.exec(body);
  }
  if (lastIndex < body.length) parts.push(body.slice(lastIndex));
  return parts;
}

/**
 * Chips de anexo de UMA mensagem já enviada (Bloco 3, T321) — cada um chama
 * `GET .../files/:fileId/url` (signed URL v4, 300 s) e abre em nova aba (o browser decide entre
 * exibir/baixar pelo `Content-Disposition: attachment` que o backend já manda). Sem nome de
 * arquivo aqui: `GET .../conversation`/`.../replies` NUNCA devolvem `originalName` (D-02 — só
 * decifra no download); o rótulo é a extensão derivada do `contentType`, forma exata do contrato.
 */
export function MessageAttachments({
  patientId, attachments,
}: { patientId: string; attachments: ConversationMessageAttachment[] }): JSX.Element | null {
  const { t } = useTranslation();
  const td = (key: string, fallback: string): string => t(`admin.patients.detail.conversation.thread.${key}`, fallback);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  if (attachments.length === 0) return null;

  /**
   * 🔒 A ABA TEM DE ABRIR NO MESMO TICK DO CLIQUE (achado medido no e2e Playwright desta sessão,
   * T321): `window.open` chamado DEPOIS de um `await` (aqui, o `GET .../files/:fileId/url`) perde
   * o "user activation" do clique — o Chrome bloqueia SILENCIOSAMENTE como pop-up, sem erro
   * nenhum no console. Corrigido abrindo a aba em branco SÍNCRONO (dentro do clique) e só
   * redirecionando (`popup.location.href`) quando a signed URL chega.
   *
   * 🔒 SEM `noopener`/`noreferrer` NO PRIMEIRO `window.open` (2º achado do mesmo e2e): a spec do
   * WHATWG faz `noreferrer` implicar `noopener` — com qualquer um dos dois, `window.open` sempre
   * devolve `null` (a aba abre de verdade no browser, mas o JS nunca recebe a referência pra
   * redirecionar depois). O popup ficava mudo pra sempre (medido: `popup.url()` nunca saía de
   * `about:blank`) e o `else` (2ª chamada, com a URL final) abria uma SEGUNDA aba órfã que o teste
   * nunca via. Sem esses parâmetros aqui é a nossa própria signed URL do bucket, não link de
   * terceiro — a referência de volta (`window.opener`) não é risco real.
   */
  const handleDownload = async (fileId: string): Promise<void> => {
    setDownloadError(null);
    const popup = window.open('', '_blank');
    try {
      const { url } = await AdminConversationApiService.getConversationAttachmentUrl(patientId, fileId);
      if (popup) popup.location.href = url;
      else window.open(url, '_blank'); // bloqueador de pop-up ativo — melhor esforço
    } catch {
      // Nunca falha silenciosa (mesma regra do `sendError` do composer): sem isto, um 403/404 no
      // download parecia clique sem efeito nenhum.
      popup?.close();
      setDownloadError(td('attachments.downloadError', 'Não conseguimos baixar o arquivo. Tente de novo.'));
    }
  };

  return (
    <div data-testid="message-attachments" className="flex flex-col gap-1 mt-1">
      {attachments.map((attachment) => {
        const Icon = iconComponentForContentType(attachment.contentType);
        return (
          <button
            key={attachment.fileId}
            type="button"
            data-testid={`message-attachment-${attachment.fileId}`}
            aria-label={td('attachments.download', 'Baixar anexo')}
            onClick={() => { void handleDownload(attachment.fileId); }}
            className="flex items-center gap-1.5 text-xs text-primary hover:underline self-start"
          >
            <Icon size={14} aria-hidden="true" />
            <span>{extensionForContentType(attachment.contentType)}</span>
          </button>
        );
      })}
      {downloadError && (
        <Text size="xs" role="alert" className="text-red-600" data-testid="message-attachments-error">
          {downloadError}
        </Text>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

/**
 * Autor + hora + corpo de UMA mensagem (topo ou reply) — sem o botão de "N respostas", que só
 * existe no item de TOPO (`ConversationPanel.MessageItem`, thread é de 1 nível). Compartilhada
 * pelas duas telas para a regra de "apagada" e o parsing de menção nunca divergirem.
 */
export function MessageContent({ message, patientId }: { message: ConversationMessage; patientId: string }): JSX.Element {
  const { t } = useTranslation();
  const td = (key: string, optsOrDefault?: Record<string, unknown> | string): string =>
    t(`admin.patients.detail.conversation.thread.${key}`, optsOrDefault as string);
  // Achado baixo do gate do B2: mostrava uid cru. `useStaffDisplayName` resolve pelo próprio
  // perfil (autor === ator logado) ou pelo cache de busca do diretório (`MessageComposer`) —
  // fallback pro uid quando nenhuma das duas resolve (nunca inventa nome, nunca quebra).
  const authorName = useStaffDisplayName(message.authorUid);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <span data-testid="message-author">{authorName}</span>
        <span data-testid="message-time">{formatTime(message.createdAt)}</span>
      </div>
      <div data-testid="message-body">
        {message.deletedAt
          ? <em>{td('deleted', 'Mensagem apagada')}</em>
          : renderMessageBody(message.body, message.mentions)}
      </div>
      {/* Mensagem apagada nunca mostra anexo (corpo cifrado já foi zerado — D-04/soft delete). */}
      {!message.deletedAt && <MessageAttachments patientId={patientId} attachments={message.attachments} />}
    </div>
  );
}

interface ThreadViewProps {
  patientId: string;
  /** A mensagem de TOPO cujas replies este componente lista — já em mão do `ConversationPanel`
   * (que a recebeu na mesma página que listou o topo); evita um segundo GET só pra reler o root. */
  rootMessage: ConversationMessage;
  onBack: () => void;
  /**
   * Ponto de EXTENSÃO: quem embrulha (`ConversationPanel`) constrói o `MessageComposer` (TipTap)
   * já plugado com `rootMessageId` e `onSent` — este componente não sabe nada sobre TipTap, só
   * reserva o slot no rodapé. Sem esta prop, a thread funciona só como leitura.
   */
  composer?: ReactNode;
  /**
   * Muda (qualquer valor novo, ex.: contador incrementado) depois de um envio bem-sucedido na
   * PRÓPRIA thread — dispara um reload SILENCIOSO das replies (sem voltar pra `status='loading'`)
   * sem esperar o usuário fechar/reabrir. `ThreadView` não faz polling (T213/T214 aceitou "carrega
   * tudo de uma vez" como escopo) — sem isto, uma reply recém-enviada só apareceria ao reabrir a
   * thread. Opcional: quem não manda, mantém o comportamento antigo (só carrega no mount).
   */
  refreshToken?: number;
}

type ThreadStatus = 'loading' | 'ready' | 'error';

/**
 * ThreadView — spec 022, Bloco 2 (T213/T214). Lista as replies de UMA mensagem de topo, na
 * ordem em que o backend devolve (`GET .../replies` já ordena `created_at ASC` — contrato).
 * Thread é de UM nível (regra do backend, `root_message_id` de uma reply nunca é outra reply) —
 * por isso não há botão de "respostas" numa reply nem recursão nenhuma aqui.
 *
 * Sem paginação: para o tamanho de thread esperado no Bloco 2, carregar tudo de uma vez é
 * decisão de escopo aceita (`tasks.md:682`), não bug.
 */
export function ThreadView({
  patientId, rootMessage, onBack, composer, refreshToken,
}: ThreadViewProps): JSX.Element {
  const { t } = useTranslation();
  const tk = (key: string): string => t(`admin.patients.detail.conversation.thread.${key}`);

  const [status, setStatus] = useState<ThreadStatus>('loading');
  const [replies, setReplies] = useState<ConversationMessage[]>([]);
  const isMountedRef = useRef(true);

  const fetchReplies = useCallback(async (): Promise<void> => {
    try {
      const result = await AdminConversationApiService.getConversationReplies(patientId, rootMessage.id);
      if (!isMountedRef.current) return;
      setReplies(result);
      setStatus('ready');
    } catch {
      // Nunca falha silenciosa (regra do brief): sem replies boas na tela, o aviso é visível,
      // não um branco que parece "carregando pra sempre" ou "sem replies".
      if (!isMountedRef.current) return;
      setStatus('error');
    }
  }, [patientId, rootMessage.id]);

  useEffect(() => {
    isMountedRef.current = true;
    setStatus('loading');
    void fetchReplies();
    return () => { isMountedRef.current = false; };
  }, [fetchReplies]);

  useEffect(() => {
    // Refresh SILENCIOSO — só dispara quando o pai muda `refreshToken` de propósito (reply
    // própria acabou de ser enviada); nunca no mount inicial (já coberto pelo efeito acima).
    if (refreshToken === undefined) return;
    void fetchReplies();
  }, [refreshToken, fetchReplies]);

  return (
    <div data-testid="thread-view" className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-3 border-b">
        <button type="button" aria-label={tk('back')} onClick={onBack} data-testid="thread-back-btn">
          ←
        </button>
        <div data-testid="thread-root-message" className="flex-1 min-w-0">
          <MessageContent message={rootMessage} patientId={patientId} />
        </div>
      </div>
      {status === 'error' && (
        <p data-testid="thread-view-error">
          {t('admin.patients.detail.conversation.thread.loadError', 'Não foi possível carregar as respostas')}
        </p>
      )}
      {status === 'ready' && (
        <ul data-testid="thread-replies-list" className="flex-1 overflow-y-auto">
          {replies.map((reply) => (
            <li key={reply.id} data-testid={`thread-reply-${reply.id}`} className="p-3 border-b">
              <MessageContent message={reply} patientId={patientId} />
            </li>
          ))}
        </ul>
      )}
      {composer}
    </div>
  );
}
