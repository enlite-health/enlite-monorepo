import { useCallback, useRef, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { usePolling } from '@hooks/usePolling';
import { useAutoOpenDrawer, type DrawerFocusRequest } from '@hooks/admin/useAutoOpenDrawer';
import { AdminConversationApiService } from '@infrastructure/http/AdminConversationApiService';
import { SlideOverPanel } from '@presentation/components/molecules/SlideOverPanel/SlideOverPanel';
import { ConversationPanel } from './ConversationPanel';
import type { MessageComposerHandle } from './MessageComposer';

const POLL_MS = 5000;

interface PatientConversationHandleProps {
  patientId: string;
  /**
   * Deep-link do sino de notificações (Spec 022, Bloco 4, T413): `NotificationPanel` navega para
   * `patients/:patientId` com `{ code: 'conversation', token }` no `location.state` — este
   * componente escuta pelo MESMO mecanismo do checklist (`useAutoOpenDrawer`) e abre o painel
   * sozinho, sem o pai (`PatientDetailPage`) saber nada sobre conversa/notificação.
   */
  focusRequest?: DrawerFocusRequest | null;
}

/**
 * Botão fixo na lateral direita da ficha do paciente (spec 022, Bloco 2, T209) — abre o painel
 * do chat interno. O badge mostra `unreadCount` do SERVIDOR (topo + replies, autor diferente do
 * ator, `createdAt > lastReadAt` — regra fechada da spec, D-10, calculada em `getReadState`) —
 * este componente nunca recalcula, só exibe.
 *
 * Vive SEMPRE por fora de `<ContainerGate resource="patient_conversation">` — quem monta (T210,
 * `PatientDetailPage.tsx`) é responsável pelo gate; este componente não se auto-protege.
 *
 * ⚠️ Decisão de integração (colisão registrada em `evidencias/achados.md`): este componente é o
 * ÚNICO dono do `SlideOverPanel` — abre/fecha e renderiza `ConversationPanel` (T211/T212) como
 * CONTEÚDO dele. `ConversationPanel` nunca embrulha o seu próprio painel.
 *
 * 🔒 DESCARTE AO FECHAR (T216/T220, achado alto em `evidencias/achados.md`): antes desta task,
 * Esc fechava o painel chamando `onClose` DIRETO — o `MessageComposer` já expunha
 * `requestClose`/`useConfirmDiscardClose` (T215/T216), mas nenhum caller de produção chamava.
 * Agora este componente guarda `composerRef` (para o `MessageComposer` ATIVO — topo ou reply,
 * nunca os dois montados juntos) e todo pedido de fechar (Esc OU o botão X, os dois centralizados
 * no `SlideOverPanel` via `onRequestClose`) passa por `handleRequestClose`, que pergunta ao
 * composer ANTES de fechar de verdade. `onClose` (chamado pelo composer só quando é seguro)
 * continua sendo o fechamento incondicional — sem composer montado (painel vazio/`forbidden`/
 * ainda carregando), não há nada a perder, então fecha direto.
 *
 * 🔒 CONSERTO (achado médio do gate do B2, `evidencias/b2-gate-pr.md`): até este conserto, o
 * badge era calculado aqui no cliente com um baseline LOCAL (`new Date(0)`) — nunca persistido —
 * e, pior, buscava as replies de TODA thread com atividade recente (`1 + N` chamadas por tick,
 * pra sempre, até o painel abrir). O `GET .../conversation` deste MESMO bloco passou a devolver
 * `unreadCount` já calculado em UMA query no servidor (`contracts/openapi-conversation.md` linha
 * 34, D-11) — o docstring antigo ("o contrato só EXPÕE escrita do read-mark, nunca leitura")
 * ficou falso a partir do B2; agora o componente só CONSOME o valor do servidor, nunca recalcula.
 * `handleOpen` chama `markConversationRead` (antes sem nenhum caller de produção) para o servidor
 * saber que este ator leu — sem isso, o próximo poll devolveria o MESMO `unreadCount` de antes de
 * abrir, e o badge nunca zeraria de verdade.
 */
export function PatientConversationHandle({ patientId, focusRequest }: PatientConversationHandleProps): JSX.Element {
  const { t } = useTranslation();
  const tc = (key: string, opts?: Record<string, unknown>): string =>
    t(`admin.patients.detail.conversation.handle.${key}`, opts);
  const tp = (key: string): string => t(`admin.patients.detail.conversation.panel.${key}`);

  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  /** `MessageComposer` ATIVO (topo ou reply) — ver docstring do componente. */
  const composerRef = useRef<MessageComposerHandle>(null);
  /** Deep-link (item 3, change 022-ux-mencao-e-notificacao): alvo repassado ao `ConversationPanel`
   * quando a notificação clicada tinha `messageId`. `null` = abertura normal (clique no botão).
   * `token` (G7): o do próprio `DrawerFocusRequest` — identifica O CLIQUE, não a mensagem, para o
   * `ConversationPanel` saber reprocessar mesmo quando é a MESMA notificação clicada de novo. */
  const [focusTarget, setFocusTarget] = useState<{ messageId: string; rootMessageId: string | null; token: number } | null>(null);

  usePolling(async () => {
    try {
      const { unreadCount: serverUnreadCount } = await AdminConversationApiService.getConversation(patientId);
      setUnreadCount(serverUnreadCount);
    } catch {
      // Silencioso de propósito: o badge é um indicador secundário — falha de poll não é canal
      // de alerta (a regra "aviso operacional só por canal oficial" não se aplica a isto).
    }
  }, POLL_MS, { pauseWhenHidden: true });

  const handleOpen = (request?: DrawerFocusRequest): void => {
    setUnreadCount(0);
    setIsPanelOpen(true);
    // Item 3 (deep-link): quando a abertura veio de uma notificação COM messageId, guarda o alvo
    // pro `ConversationPanel` processar (rolar/destacar). Clique direto no botão (sem `request`,
    // ou notificação sem `messageId` — D-08) mantém o comportamento antigo: abertura normal.
    setFocusTarget(
      request?.messageId
        ? { messageId: request.messageId, rootMessageId: request.rootMessageId ?? null, token: request.token }
        : null,
    );
    // Persiste a marca de leitura no servidor — sem isto, o badge zera aqui só na TELA, mas o
    // próximo GET (poll ou reload) devolveria o `unreadCount` de ANTES de abrir. Mesmo freio das
    // outras falhas deste componente: best-effort, badge não é canal de alerta.
    void AdminConversationApiService.markConversationRead(patientId).catch(() => {});
  };

  // Deep-link do sino (T413/item 3): mesmo mecanismo do checklist (US-D1) — abre o painel sozinho
  // quando `focusRequest.code === 'conversation'`, nunca duas vezes pelo MESMO token; agora também
  // repassa `messageId`/`rootMessageId` (se vierem) pro `ConversationPanel`.
  useAutoOpenDrawer(focusRequest, 'conversation', handleOpen);

  /** Chamado pelo `ConversationPanel` depois de processar o alvo (achado ou esgotado) — evita
   * reprocessar o MESMO alvo se o painel re-renderizar sem um clique novo. */
  const handleFocusHandled = useCallback((): void => setFocusTarget(null), []);

  /** Fechamento incondicional — chamado pelo composer (via `onComposerClose`) só quando é seguro
   * (rascunho vazio, ou descarte confirmado), e usado como fallback quando não há composer
   * montado (nada a perder). */
  const handlePanelClose = useCallback((): void => setIsPanelOpen(false), []);

  /** Todo pedido de fechar (Esc ou botão X, os dois centralizados no `SlideOverPanel`) passa por
   * aqui: pergunta ao composer ATIVO antes de fechar de verdade (T216/T220). */
  const handleRequestClose = useCallback((): void => {
    if (composerRef.current) {
      composerRef.current.requestClose();
      return;
    }
    handlePanelClose();
  }, [handlePanelClose]);

  return (
    <>
      <button
        type="button"
        data-testid="patient-conversation-handle-btn"
        aria-label={tc('label')}
        onClick={() => handleOpen()}
        className="fixed right-0 top-1/2 -translate-y-1/2 z-30 flex flex-col items-center gap-1 bg-primary px-2 py-3 rounded-l-lg shadow-lg hover:bg-primary/90 transition-colors"
      >
        <MessageCircle className="w-4 h-4 text-white" />
        <Text as="span" size="2xs" weight="medium" color="white">
          {tc('label')}
        </Text>
        {unreadCount > 0 && (
          <span
            data-testid="patient-conversation-handle-badge"
            aria-label={tc('unread', { count: unreadCount })}
            className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-600"
          >
            <Text as="span" size="2xs" weight="semibold" color="white" className="!leading-none">
              {unreadCount}
            </Text>
          </span>
        )}
      </button>
      <SlideOverPanel
        isOpen={isPanelOpen}
        onClose={handlePanelClose}
        onRequestClose={handleRequestClose}
        ariaLabel={tc('label')}
        closeAriaLabel={tp('close')}
        testId="patient-conversation-panel"
      >
        <ConversationPanel
          patientId={patientId}
          isOpen={isPanelOpen}
          composerRef={composerRef}
          onComposerClose={handlePanelClose}
          focusTarget={focusTarget}
          onFocusHandled={handleFocusHandled}
        />
      </SlideOverPanel>
    </>
  );
}
