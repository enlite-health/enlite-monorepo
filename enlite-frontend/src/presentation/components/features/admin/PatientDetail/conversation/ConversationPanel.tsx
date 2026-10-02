import { lazy, Suspense, useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminConversationApiService, type ConversationMessage } from '@infrastructure/http/AdminConversationApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import { usePolling } from '@hooks/usePolling';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { Text } from '@presentation/components/atoms/Text';
import { InlineLoadingState } from '@presentation/components/molecules/InlineLoadingState/InlineLoadingState';
import { MessageContent, ThreadView } from './ThreadView';
import { ReplyThreadBadge } from './ReplyThreadBadge';
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
  /**
   * Deep-link (item 3, change 022-ux-mencao-e-notificacao): alvo a rolar/destacar ao abrir —
   * vem da notificação clicada (`NotificationPanel` → `PatientConversationHandle`). `null`/ausente
   * = abertura normal, sem alvo nenhum.
   *
   * `token` (G7, achado do gate desta change): identifica O CLIQUE, não a mensagem — o mesmo
   * `messageId` pode chegar de novo (usuária clica na MESMA notificação de novo com o painel já
   * aberto). Opcional só para não quebrar quem ainda não tem um clique pra identificar (a guarda
   * de reprocessamento cai para o `messageId` quando ausente — ver `processedFocusKeyRef`).
   */
  focusTarget?: { messageId: string; rootMessageId: string | null; token?: number } | null;
  /** Chamado depois que o alvo foi PROCESSADO (achado ou esgotado as páginas) — quem embrulha usa
   * isto para não reprocessar o mesmo alvo numa próxima renderização. */
  onFocusHandled?: () => void;
}

type PanelStatus = 'loading' | 'forbidden' | 'ready' | 'error';

/** ~2s, com fade (design.md §3, Prior-art GitHub "comment mention"). */
const HIGHLIGHT_DURATION_MS = 2000;
/** Teto de segurança do loop de páginas (item 3, F16) — nunca itera pra sempre mesmo com um
 * backend que devolvesse cursor não-null indefinidamente por engano. */
const MAX_FOCUS_SEARCH_PAGES = 50;

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
  /** Deep-link (item 3): true = esta é a mensagem-alvo da notificação clicada. */
  highlighted?: boolean;
  /** G6: ver `MessageContentProps.onHighlighted` — repassado direto. */
  onHighlighted?: () => void;
}

/**
 * Item de mensagem de TOPO: `MessageContent` (CARD — avatar/nome/hora/corpo/anexo, compartilhado
 * com a `ThreadView`) com o RODAPÉ do card (ajustes de UI B5, molde ClickUp — rodada 2, achado
 * "0 respuestas" + pedido do selo): "Responder" sempre visível; o SELO (`ReplyThreadBadge`) só
 * quando `replyCount >= 1` — os dois AGRUPADOS à direita (`justify-end` no wrapper de
 * `ThreadView.MessageContent`), selo ANTES do botão. Ambos abrem a MESMA thread —
 * `onOpenThread` não muda por quem clicou.
 */
function MessageItem({ message, patientId, onOpenThread, highlighted = false, onHighlighted }: MessageItemProps): JSX.Element {
  const { t } = useTranslation();
  const th = (key: string, optsOrDefault?: Record<string, unknown> | string): string =>
    t(`admin.patients.detail.conversation.thread.${key}`, optsOrDefault as string);

  const footer = (
    <>
      <ReplyThreadBadge count={message.replyCount} onOpenThread={onOpenThread} />
      <button
        type="button"
        onClick={onOpenThread}
        aria-label={th('reply', 'Responder')}
        data-testid="conversation-message-reply-btn"
      >
        <Text as="span" size="xs" weight="medium" color="primary">{th('reply', 'Responder')}</Text>
      </button>
    </>
  );

  return (
    <div data-testid={`conversation-message-${message.id}`} className="px-3 py-2">
      <MessageContent message={message} patientId={patientId} footer={footer} highlighted={highlighted} onHighlighted={onHighlighted} />
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
  patientId, isOpen, composerRef, onComposerClose, focusTarget, onFocusHandled,
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
  const messagesRef = useRef<ConversationMessage[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  /** Deep-link (item 3): id da mensagem a destacar (root OU top-level), `null` = sem destaque. */
  const [highlightMessageId, setHighlightMessageId] = useState<string | null>(null);
  /** `messageId` do alvo que ESGOTOU as páginas sem ser achado — mostra o aviso "não encontrada"
   * sem travar o resto do painel (design.md §3, cenário "mensagem fora da 1ª página"). */
  const [notFoundTargetId, setNotFoundTargetId] = useState<string | null>(null);
  /**
   * Chave do `focusTarget` já processado nesta abertura — evita reprocessar o MESMO alvo a cada
   * re-render (o pai pode manter a mesma referência de objeto entre renders).
   *
   * G7 (achado do gate desta change): a chave é o `token` do clique quando ele vem (não só o
   * `messageId`) — antes, a guarda comparava só `messageId`, e como ela NUNCA era resetada fora
   * de abrir o painel/trocar de paciente, clicar de nova na MESMA notificação com o painel JÁ
   * aberto (2º clique, `token` novo, mesmo `messageId`) caía nesta guarda e nunca era processado —
   * nem o destaque acontecia, nem `onFocusHandled` era chamado (o `focusTarget` ficava preso no
   * pai para sempre). Sem `token` (chamador antigo/teste que não o passa), cai no `messageId`
   * puro — comportamento inalterado.
   */
  const processedFocusKeyRef = useRef<string | null>(null);
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
    setHighlightMessageId(null);
    setNotFoundTargetId(null);
    processedFocusKeyRef.current = null;
    void fetchPage();
  }, [isOpen, patientId, fetchPage]);

  usePolling(() => {
    if (!isOpen || status === 'forbidden') return;
    void fetchPage(cursorRef.current ?? undefined);
  }, POLL_MS, { pauseWhenHidden: true });

  // Deep-link (item 3, design.md §3 — decisão de menor diff F16): carrega páginas em loop,
  // reaproveitando `fetchPage`/`cursorRef`, até achar a mensagem-alvo (ou o ROOT dela, se for
  // reply) ou esgotar (`nextCursor === null`). A busca por página ASC garante que qualquer
  // mensagem ausente da 1ª carga é necessariamente MAIS NOVA (F14) — nunca "mais antiga",
  // então o loop para frente sempre alcança, sem precisar de "carregar anterior".
  useEffect(() => {
    if (!isOpen || !focusTarget || status !== 'ready') return;
    // G7: chave por TOKEN quando o clique traz um — cada clique novo (mesmo `messageId` de antes)
    // tem `token` diferente e por isso é reprocessado. Sem `token`, cai no `messageId` puro.
    const focusKey = focusTarget.token !== undefined ? `token:${focusTarget.token}` : `msg:${focusTarget.messageId}`;
    if (processedFocusKeyRef.current === focusKey) return;
    const target = focusTarget;
    let cancelled = false;

    (async () => {
      const searchId = target.rootMessageId ?? target.messageId;
      let found = messagesRef.current.find((m) => m.id === searchId) ?? null;
      let cursor = cursorRef.current;
      let guard = 0;
      while (!found && cursor !== null && guard < MAX_FOCUS_SEARCH_PAGES) {
        guard += 1;
        let page;
        try {
          page = await AdminConversationApiService.getConversation(patientId, { after: cursor });
        } catch {
          break; // rede falhou no meio da busca — trata como esgotado, nunca trava a UI.
        }
        if (cancelled || !isMountedRef.current) return;
        setMessages((prev) => mergeById(prev, page.messages));
        messagesRef.current = mergeById(messagesRef.current, page.messages);
        cursorRef.current = page.nextCursor;
        cursor = page.nextCursor;
        found = page.messages.find((m) => m.id === searchId) ?? null;
      }
      if (cancelled || !isMountedRef.current) return;
      processedFocusKeyRef.current = focusKey;
      if (!found) {
        setNotFoundTargetId(target.messageId);
        onFocusHandled?.();
        return;
      }
      setNotFoundTargetId(null);
      if (target.rootMessageId) {
        setOpenThreadId(found.id); // `found` é o ROOT — abre a thread pra revelar a reply-alvo.
      }
      setHighlightMessageId(target.messageId);
      onFocusHandled?.();
    })();

    return () => { cancelled = true; };
  }, [isOpen, focusTarget, status, patientId, onFocusHandled]);

  // Destaque é MOMENTÂNEO (~2s, design.md §3) — o próprio `MessageContent` faz o fade via CSS
  // quando esta prop volta a `false`; aqui só o TIMER que decide QUANDO isso acontece.
  //
  // G6 (achado do gate desta change): o timer NÃO começa quando `highlightMessageId` é setado —
  // começa só quando `MessageContent` avisa (`onHighlighted`) que o card-ALVO já está no DOM e já
  // tentou rolar. Antes, para uma REPLY, `highlightMessageId` era setado no MESMO tick em que a
  // thread abria (`setOpenThreadId`) — e `ThreadView.fetchReplies` é assíncrono. Numa rede lenta,
  // os ~2s do timer antigo esgotavam ANTES da reply sequer existir no DOM: o destaque já tinha
  // sido desligado quando ela finalmente aparecia, e a usuária nunca via o flash nem o scroll.
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHighlightTimer = useCallback((): void => {
    if (highlightTimerRef.current !== null) {
      clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
  }, []);
  const handleHighlightShown = useCallback(
    (messageId: string): void => {
      // Alvo pode ter mudado (novo deep-link) entre o card antigo desmontar e este callback
      // chegar — só inicia o timer se ainda for o alvo ATUAL.
      if (messageId !== highlightMessageId) return;
      clearHighlightTimer();
      highlightTimerRef.current = setTimeout(() => {
        highlightTimerRef.current = null;
        setHighlightMessageId(null);
      }, HIGHLIGHT_DURATION_MS);
    },
    [highlightMessageId, clearHighlightTimer],
  );
  // Painel fechado/trocou de alvo por fora (reset da abertura) — nenhum timer pendente deve
  // sobreviver, e limpeza no unmount por segurança.
  useEffect(() => {
    if (!highlightMessageId) clearHighlightTimer();
    return clearHighlightTimer;
  }, [highlightMessageId, clearHighlightTimer]);

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
      {/* `flex-shrink-0`: sem isto, o flexbox pode espremer header/rodapé quando a lista do meio
       * é alta demais — o `flex-1 overflow-y-auto` é o ÚNICO que deve ceder (rolar), nunca o
       * cabeçalho nem o compositor (achado "Enviar cortado embaixo", ajustes de UI B5). */}
      <div className="p-4 border-b font-medium flex-shrink-0" data-testid="conversation-panel-header">{tp('title')}</div>
      <div className="flex-1 overflow-y-auto min-h-0">
        {openThreadMessage ? (
          <ThreadView
            patientId={patientId}
            rootMessage={openThreadMessage}
            onBack={() => setOpenThreadId(null)}
            refreshToken={replyRefreshToken}
            highlightMessageId={highlightMessageId}
            onHighlightShown={handleHighlightShown}
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
                <p data-testid="conversation-panel-read-only" className="p-3 text-xs text-gray-800 border-t flex-shrink-0">
                  {tp('readOnly')}
                </p>
              )
            ) : undefined}
          />
        ) : (
          <>
            {status === 'loading' && (
              <InlineLoadingState label={tp('loading')} data-testid="conversation-panel-loading" />
            )}
            {status === 'forbidden' && (
              <p data-testid="conversation-panel-no-access" className="p-4 text-gray-800">{tp('noAccess')}</p>
            )}
            {status === 'error' && (
              <div className="flex flex-col items-center gap-2 p-4">
                <Text size="xs" role="alert" className="text-red-600" data-testid="conversation-panel-error">
                  {tp('loadError')}
                </Text>
                <button
                  type="button"
                  data-testid="conversation-panel-retry"
                  onClick={() => void fetchPage()}
                  className="text-xs text-primary hover:underline"
                >
                  {tp('retry')}
                </button>
              </div>
            )}
            {status === 'ready' && notFoundTargetId && (
              // Deep-link esgotou as páginas sem achar o alvo (design.md §3) — aviso explícito,
              // nunca uma UI travada nem um silêncio que parece bug.
              <div data-testid="conversation-message-not-found" className="px-4 py-2 flex-shrink-0">
                <Text size="xs" className="text-gray-800">{tp('messageNotFound')}</Text>
              </div>
            )}
            {status === 'ready' && messages.length === 0 && (
              <p data-testid="conversation-panel-empty" className="p-4 text-gray-800">{tp('empty')}</p>
            )}
            {status === 'ready' && messages.length > 0 && (
              <ul data-testid="conversation-panel-list">
                {messages.map((m) => (
                  <li key={m.id}>
                    <MessageItem
                      message={m}
                      patientId={patientId}
                      onOpenThread={() => setOpenThreadId(m.id)}
                      highlighted={m.id === highlightMessageId}
                      onHighlighted={() => handleHighlightShown(m.id)}
                    />
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
          <p data-testid="conversation-panel-read-only" className="p-3 text-xs text-gray-800 border-t flex-shrink-0">
            {tp('readOnly')}
          </p>
        )
      )}
    </div>
  );
}
