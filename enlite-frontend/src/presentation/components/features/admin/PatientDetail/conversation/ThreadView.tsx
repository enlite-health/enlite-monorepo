import { useCallback, useEffect, useRef, useState, type ReactNode, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AdminConversationApiService,
  type ConversationMessage,
} from '@infrastructure/http/AdminConversationApiService';
import { useStaffDisplayName } from '@presentation/stores/staffNameCache';
import { Text } from '@presentation/components/atoms/Text';
import { MessageAvatar } from './MessageAvatar';
import { MessageAttachments } from './MessageAttachments';
import { formatMessageDateTime } from './messageDateFormat';

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
 * Reaproveitada pelo `MessageContent` abaixo — MESMA regra de renderização nos dois lugares
 * (mensagem de topo e reply) que `ConversationPanel.tsx` usa, sem duplicar a lógica de parsing.
 * Não exportada: nada fora deste arquivo importa a função diretamente (só via `MessageContent`).
 */
function renderMessageBody(body: string, mentions: readonly string[]): ReactNode[] {
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
 * Autor + hora + corpo + anexos de UMA mensagem (topo ou reply) — CARD (ajustes de UI B5, molde
 * do comentário do ClickUp que o Gabriel mostrou): borda sutil, cantos arredondados, cabeçalho com
 * avatar (`MessageAvatar`, sempre iniciais — ver comentário do componente) + nome + data/hora
 * localizada, corpo com quebra de linha preservada (`whitespace-pre-wrap`, achado do ajuste de
 * quebras de linha — o `\n`/`\n\n` que o TipTap já serializa corretamente estava chegando intacto
 * até aqui; só faltava a CSS que preserva visualmente), anexos (miniatura de imagem OU chip
 * PDF/DOCX, `MessageAttachments`).
 *
 * `footer` é o rodapé "Responder"/"N respuestas" — ponto de EXTENSÃO, só quem embrulha decide se
 * existe: `ConversationPanel.MessageItem` (mensagem de TOPO da lista) passa um; `ThreadView` (root
 * da thread aberta E cada reply) nunca passa — thread é de 1 NÍVEL, não existe "responder" dentro
 * de uma reply, e o root já está dentro da própria thread aberta (sem ação de reabri-la).
 *
 * 🔒 Contraste (ajuste de UI B5, achado "autor/hora quase invisíveis"): `Text color="secondary"`
 * resolve para `text-gray-800` (`#737373`) — medido nesta sessão (luminância relativa W3C) como
 * 4.74:1 contra fundo branco, ≥ 4.5:1 (WCAG AA). O `gray-500` antigo (`rgba(217,217,217,0.5)`,
 * classe raw fora do atom) dava ~1.2:1 sobre branco — por isso quase sumia.
 */
export interface MessageContentProps {
  message: ConversationMessage;
  patientId: string;
  footer?: ReactNode;
}

export function MessageContent({ message, patientId, footer }: MessageContentProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const td = (key: string, optsOrDefault?: Record<string, unknown> | string): string =>
    t(`admin.patients.detail.conversation.thread.${key}`, optsOrDefault as string);
  // Achado baixo do gate do B2: mostrava uid cru. `useStaffDisplayName` resolve pelo próprio
  // perfil (autor === ator logado) ou pelo cache de busca do diretório (`MessageComposer`) —
  // fallback pro uid quando nenhuma das duas resolve (nunca inventa nome, nunca quebra).
  const authorName = useStaffDisplayName(message.authorUid);
  const connector = td('dateConnector', i18n.language.toLowerCase().startsWith('pt') ? 'às' : 'a las');
  const dateLabel = formatMessageDateTime(message.createdAt, i18n.language, connector);

  return (
    <div data-testid={`message-card-${message.id}`} className="flex flex-col gap-2 rounded-xl border border-gray-300 bg-white p-3 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <MessageAvatar uid={message.authorUid} name={authorName} />
        <Text as="span" size="sm" weight="medium" className="truncate" data-testid="message-author">
          {authorName}
        </Text>
        <Text as="span" size="xs" className="ml-auto flex-shrink-0 whitespace-nowrap" data-testid="message-time">
          {dateLabel}
        </Text>
      </div>
      <div data-testid="message-body" className="whitespace-pre-wrap break-words text-sm">
        {message.deletedAt
          ? <em>{td('deleted', 'Mensagem apagada')}</em>
          : renderMessageBody(message.body, message.mentions)}
      </div>
      {/* Mensagem apagada nunca mostra anexo (corpo cifrado já foi zerado — D-04/soft delete). */}
      {!message.deletedAt && <MessageAttachments patientId={patientId} attachments={message.attachments} />}
      {footer && (
        <div className="flex items-center justify-between pt-2 mt-1 border-t border-gray-200">
          {footer}
        </div>
      )}
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
      <div className="flex items-center gap-2 p-3 border-b min-w-0">
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
        <ul data-testid="thread-replies-list" className="flex-1 overflow-y-auto flex flex-col gap-2 p-2">
          {replies.map((reply) => (
            <li key={reply.id} data-testid={`thread-reply-${reply.id}`} className="min-w-0">
              <MessageContent message={reply} patientId={patientId} />
            </li>
          ))}
        </ul>
      )}
      {composer}
    </div>
  );
}
