import { lazy, Suspense, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminConversationApiService, type ConversationMessage } from '@infrastructure/http/AdminConversationApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import { usePolling } from '@hooks/usePolling';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { Text } from '@presentation/components/atoms/Text';
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

type PanelStatus = 'loading' | 'forbidden' | 'ready' | 'error';

function mergeById(prev: ConversationMessage[], incoming: ConversationMessage[]): ConversationMessage[] {
  if (incoming.length === 0) return prev;
  const byId = new Map(prev.map((m) => [m.id, m] as const));
  for (const m of incoming) byId.set(m.id, m);
  return Array.from(byId.values());
}

interface MessageItemProps {
  message: ConversationMessage;
  patientId: string;
  onOpenThread: () => void;
}

/** Item de mensagem de TOPO: `MessageContent` (autor/hora/corpo/anexo, compartilhado com a
 * `ThreadView`) + o botão "N respostas" que abre a thread — só existe aqui, nunca numa reply
 * (1 nível). */
function MessageItem({ message, patientId, onOpenThread }: MessageItemProps): JSX.Element {
  const { t } = useTranslation();
  const repliesLabel = t('admin.patients.detail.conversation.thread.replies', { count: message.replyCount });

  return (
    <div data-testid={`conversation-message-${message.id}`} className="flex flex-col gap-1 p-3 border-b">
      <MessageContent message={message} patientId={patientId} />
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
 * 🔒 CONSERTO (achado médio do gate do B2, `evidencias/b2-gate-pr.md`): erro não-403 na carga
 * INICIAL (nunca carregou uma lista boa) prendia `status` em `'loading'` pra sempre — painel em
 * branco, sem aviso. Agora vira `'error'` (molde igual ao `ThreadView`, vizinho). Erro num POLL
 * depois de já ter carregado uma vez continua silencioso de propósito (mantém a última lista boa
 * na tela) — só a carga inicial (`hasLoadedOnceRef.current === false`) tem `status` visível.
 *
 * 🔒 CONSERTO (achado alto do gate do B2): o compositor (topo e reply) só é oferecido a quem tem
 * `patient_conversation:create` (`useActionGate`, mesmo freio de enforcement do `ActionButton`/
 * D268/D269) — quem só tem `:read` vê um aviso (`panel.readOnly`), nunca um campo que daria 403
 * em silêncio no clique.
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

  /** `patient_conversation:create` — quem só tem `:read` não vê o compositor (achado alto do
   * gate do B2): antes disto, o campo aparecia pra todo mundo e o clique dava 403 em silêncio. */
  const { allowed: canCompose } = useActionGate('patient_conversation', 'create');

  const [status, setStatus] = useState<PanelStatus>('loading');
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [replyRefreshToken, setReplyRefreshToken] = useState<number | undefined>(undefined);
  const cursorRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);
  /** `true` a partir da 1ª resposta boa desta abertura — separa "carga inicial falhou" (mostra
   * `'error'`, painel nunca carregou nada) de "poll depois de já ter carregado" (silencioso,
   * mantém a última lista boa — comportamento antigo, preservado). */
  const hasLoadedOnceRef = useRef(false);

  const fetchPage = useCallback(async (after?: string): Promise<void> => {
    try {
      const result = await AdminConversationApiService.getConversation(patientId, after ? { after } : undefined);
      if (!isMountedRef.current) return;
      setMessages((prev) => mergeById(after ? prev : [], result.messages));
      cursorRef.current = result.nextCursor;
      setStatus('ready');
      hasLoadedOnceRef.current = true;
    } catch (err) {
      if (!isMountedRef.current) return;
      if (err instanceof ApiError && err.status === 403) {
        setStatus('forbidden');
        return;
      }
      if (!hasLoadedOnceRef.current) {
        // Carga INICIAL falhou (nunca teve uma lista boa) — painel em branco pra sempre seria
        // falha silenciosa (achado médio do gate do B2). Molde igual ao `ThreadView` vizinho.
        setStatus('error');
        return;
      }
      // Erro transitório de POLL (rede), depois de já ter carregado uma vez: mantém o estado e a
      // última lista boa na tela. Silencioso de propósito, mesma decisão de
      // `PatientConversationHandle` (badge): não é canal de alerta.
    }
  }, [patientId]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    cursorRef.current = null;
    hasLoadedOnceRef.current = false;
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
              canCompose ? (
                <Suspense fallback={null}>
                  <LazyMessageComposer
                    ref={composerRef}
                    patientId={patientId}
                    rootMessageId={openThreadMessage.id}
                    onSent={handleReplySent}
                    onClose={onComposerClose}
                  />
                </Suspense>
              ) : (
                <p data-testid="conversation-panel-read-only" className="p-3 text-xs text-gray-500 border-t">
                  {tp('readOnly')}
                </p>
              )
            ) : undefined}
          />
        ) : (
          <>
            {status === 'forbidden' && (
              <p data-testid="conversation-panel-no-access" className="p-4 text-gray-500">{tp('noAccess')}</p>
            )}
            {status === 'error' && (
              <Text size="xs" role="alert" className="text-red-600 p-4" data-testid="conversation-panel-error">
                {tp('loadError')}
              </Text>
            )}
            {status === 'ready' && messages.length === 0 && (
              <p data-testid="conversation-panel-empty" className="p-4 text-gray-500">{tp('empty')}</p>
            )}
            {status === 'ready' && messages.length > 0 && (
              <ul data-testid="conversation-panel-list">
                {messages.map((m) => (
                  <li key={m.id}>
                    <MessageItem message={m} patientId={patientId} onOpenThread={() => setOpenThreadId(m.id)} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      {!openThreadMessage && status === 'ready' && isOpen && (
        canCompose ? (
          <Suspense fallback={null}>
            <LazyMessageComposer
              ref={composerRef}
              patientId={patientId}
              onSent={handleTopMessageSent}
              onClose={onComposerClose}
            />
          </Suspense>
        ) : (
          <p data-testid="conversation-panel-read-only" className="p-3 text-xs text-gray-500 border-t">
            {tp('readOnly')}
          </p>
        )
      )}
    </div>
  );
}
