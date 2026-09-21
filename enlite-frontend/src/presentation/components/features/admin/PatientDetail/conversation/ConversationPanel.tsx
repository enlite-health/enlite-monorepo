import { lazy, Suspense, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminConversationApiService, type ConversationMessage } from '@infrastructure/http/AdminConversationApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import { usePolling } from '@hooks/usePolling';
import { MessageContent, ThreadView } from './ThreadView';
import type { MessageComposerHandle } from './MessageComposer';

const POLL_MS = 5000;

/**
 * TipTap (`MessageComposer`) só entra no bundle quando o painel realmente é usado — `lazy` +
 * `Suspense` (import dinâmico) em vez de import estático no topo do arquivo. Sem isto, o chunk
 * do editor carregaria assim que a ficha do paciente monta o `PatientConversationHandle`, mesmo
 * que a operadora nunca abra o chat.
 */
const LazyMessageComposer = lazy(() => import('./MessageComposer').then((m) => ({ default: m.MessageComposer })));

interface ConversationPanelProps {
  patientId: string;
  isOpen: boolean;
  /**
   * Ref para o `MessageComposer` ATIVO (topo OU reply — só um dos dois está montado por vez, o
   * ternário abaixo garante isso). `PatientConversationHandle` usa isto para perguntar ao
   * composer se pode fechar (T216/T220) antes de fechar o `SlideOverPanel` de verdade — sem isto,
   * o Handle não tem como saber se há rascunho não vazio.
   */
  composerRef?: RefObject<MessageComposerHandle>;
  /**
   * Fechamento CONFIRMADO (rascunho vazio, ou descarte confirmado pelo usuário) — repassado ao
   * `onClose` do `MessageComposer` ativo. Nunca chamado direto por este componente; só o
   * composer decide quando é seguro chamar.
   */
  onComposerClose?: () => void;
}

type PanelStatus = 'loading' | 'forbidden' | 'ready';

function mergeById(prev: ConversationMessage[], incoming: ConversationMessage[]): ConversationMessage[] {
  if (incoming.length === 0) return prev;
  const byId = new Map(prev.map((m) => [m.id, m] as const));
  for (const m of incoming) byId.set(m.id, m);
  return Array.from(byId.values());
}

interface MessageItemProps {
  message: ConversationMessage;
  onOpenThread: () => void;
}

/** Item de mensagem de TOPO: `MessageContent` (autor/hora/corpo, compartilhado com a `ThreadView`)
 * + o botão "N respostas" que abre a thread — só existe aqui, nunca numa reply (1 nível). */
function MessageItem({ message, onOpenThread }: MessageItemProps): JSX.Element {
  const { t } = useTranslation();
  const repliesLabel = t('admin.patients.detail.conversation.thread.replies', { count: message.replyCount });

  return (
    <div data-testid={`conversation-message-${message.id}`} className="flex flex-col gap-1 p-3 border-b">
      <MessageContent message={message} />
      <button
        type="button"
        onClick={onOpenThread}
        aria-label={repliesLabel}
        className="self-start text-xs text-primary hover:underline"
      >
        {repliesLabel}
      </button>
    </div>
  );
}

/**
 * ConversationPanel — spec 022, Bloco 2 (T211/T212). Lista as mensagens de TOPO da conversa do
 * paciente. Poll a cada 5s com `after=<cursor>`: só busca o que é NOVO, nunca a página inteira de
 * novo — `usePolling` fica no nível mais alto deste componente (nunca dentro de um item da
 * lista, senão dispara N vezes por render).
 *
 * 403 é estado PRÓPRIO (`panel.noAccess`), nunca lista vazia: distinguir "não há mensagem" de
 * "você não pode ver" é o ponto — lista vazia num 403 faria a tela mentir.
 *
 * ⚠️ Decisão de integração (colisão registrada em `evidencias/achados.md`, resolvida na sessão de
 * integração do B2): `PatientConversationHandle` é o ÚNICO dono do `SlideOverPanel` — ele abre/
 * fecha e passa `isOpen` pra baixo. Este componente é só o CONTEÚDO de dentro do painel (não
 * modal, D-12 — a operadora segue usando a ficha com o painel aberto), nunca embrulha o seu
 * próprio `SlideOverPanel`.
 *
 * 🔒 DESCARTE (T220, `evidencias/b2-conserto-descarte.md`): este componente NÃO decide se pode
 * fechar — só repassa `composerRef`/`onComposerClose` para o `MessageComposer` ATIVO (topo ou
 * reply, nunca os dois montados ao mesmo tempo). É o Handle quem chama
 * `composerRef.current.requestClose()` (Esc ou botão X do `SlideOverPanel`) e só chama
 * `onComposerClose` de fato quando o próprio composer decidir que é seguro (rascunho vazio, ou
 * descarte confirmado pelo usuário).
 */
export function ConversationPanel({
  patientId, isOpen, composerRef, onComposerClose,
}: ConversationPanelProps): JSX.Element {
  const { t } = useTranslation();
  const tp = (key: string): string => t(`admin.patients.detail.conversation.panel.${key}`);

  const [status, setStatus] = useState<PanelStatus>('loading');
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [replyRefreshToken, setReplyRefreshToken] = useState<number | undefined>(undefined);
  const cursorRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);

  const fetchPage = useCallback(async (after?: string): Promise<void> => {
    try {
      const result = await AdminConversationApiService.getConversation(patientId, after ? { after } : undefined);
      if (!isMountedRef.current) return;
      setMessages((prev) => mergeById(after ? prev : [], result.messages));
      cursorRef.current = result.nextCursor;
      setStatus('ready');
    } catch (err) {
      if (!isMountedRef.current) return;
      if (err instanceof ApiError && err.status === 403) {
        setStatus('forbidden');
      }
      // Erro transitório de poll (rede) não troca o estado — mantém a última lista boa na tela.
      // Silencioso de propósito, mesma decisão de `PatientConversationHandle` (badge): não é
      // canal de alerta.
    }
  }, [patientId]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    cursorRef.current = null;
    setOpenThreadId(null);
    setStatus('loading');
    setMessages([]);
    void fetchPage();
  }, [isOpen, patientId, fetchPage]);

  usePolling(() => {
    if (!isOpen || status === 'forbidden') return;
    void fetchPage(cursorRef.current ?? undefined);
  }, POLL_MS, { pauseWhenHidden: true });

  // Sem `openThreadId`, nenhuma mensagem tem `id === null` — o fallback já resolve pra `null`
  // sem precisar de um ternário extra por fora (branch que só existiria pra nunca ser tomada).
  const openThreadMessage = messages.find((m) => m.id === openThreadId) ?? null;

  // T3 (compositor plugado): envio bem-sucedido de topo NÃO espera o próximo tick do poll (até
  // 5s) — refaz a mesma busca que o poll já faz (`fetchPage` com o cursor atual). `mergeById` já
  // deduplica por `id`; quando o poll seguinte chegar com a MESMA mensagem, não duplica.
  const handleTopMessageSent = useCallback((): void => {
    void fetchPage(cursorRef.current ?? undefined);
  }, [fetchPage]);

  // Reply na thread aberta: o próprio `ThreadView` não faz polling — o `refreshToken` (qualquer
  // valor novo) dispara o reload silencioso das replies dentro dele.
  const handleReplySent = useCallback((): void => {
    setReplyRefreshToken((n) => (n ?? 0) + 1);
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b font-medium" data-testid="conversation-panel-header">{tp('title')}</div>
      <div className="flex-1 overflow-y-auto">
        {openThreadMessage ? (
          <ThreadView
            patientId={patientId}
            rootMessage={openThreadMessage}
            onBack={() => setOpenThreadId(null)}
            refreshToken={replyRefreshToken}
            composer={isOpen ? (
              <Suspense fallback={null}>
                <LazyMessageComposer
                  ref={composerRef}
                  patientId={patientId}
                  rootMessageId={openThreadMessage.id}
                  onSent={handleReplySent}
                  onClose={onComposerClose}
                />
              </Suspense>
            ) : undefined}
          />
        ) : (
          <>
            {status === 'forbidden' && (
              <p data-testid="conversation-panel-no-access" className="p-4 text-gray-500">{tp('noAccess')}</p>
            )}
            {status === 'ready' && messages.length === 0 && (
              <p data-testid="conversation-panel-empty" className="p-4 text-gray-500">{tp('empty')}</p>
            )}
            {status === 'ready' && messages.length > 0 && (
              <ul data-testid="conversation-panel-list">
                {messages.map((m) => (
                  <li key={m.id}>
                    <MessageItem message={m} onOpenThread={() => setOpenThreadId(m.id)} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      {!openThreadMessage && status === 'ready' && isOpen && (
        <Suspense fallback={null}>
          <LazyMessageComposer
            ref={composerRef}
            patientId={patientId}
            onSent={handleTopMessageSent}
            onClose={onComposerClose}
          />
        </Suspense>
      )}
    </div>
  );
}
