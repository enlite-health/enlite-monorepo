import { useCallback, useRef, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { usePolling } from '@hooks/usePolling';
import { AdminConversationApiService, type ConversationMessage } from '@infrastructure/http/AdminConversationApiService';
import { SlideOverPanel } from '@presentation/components/molecules/SlideOverPanel/SlideOverPanel';
import { ConversationPanel } from './ConversationPanel';
import type { MessageComposerHandle } from './MessageComposer';

const POLL_MS = 5000;

interface PatientConversationHandleProps {
  patientId: string;
}

/**
 * Botão fixo na lateral direita da ficha do paciente (spec 022, Bloco 2, T209) — abre o painel
 * do chat interno. O badge conta mensagens (topo + replies) com `createdAt > lastReadAt` e autor
 * diferente do ator logado — a própria mensagem NUNCA conta como não lida (regra fechada da
 * spec, D-10).
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
 * `lastReadAtRef` é local ao componente: o contrato de `contracts/openapi-conversation.md` só
 * EXPÕE escrita do read-mark (`PUT .../read-mark`), nunca leitura do `last_read_at` persistido em
 * `conversation_read_marks` — não há hoje uma rota que devolva esse valor ao frontend. Por isso o
 * baseline aqui é "desde que este componente montou nesta aba": abrir o painel marca como lido
 * (zera o badge) só para esta sessão de navegador. Gap de persistência entre reloads registrado
 * em `specs/022-chat-interno-por-paciente/evidencias/achados.md` — fora do escopo de T208-T210.
 */
export function PatientConversationHandle({ patientId }: PatientConversationHandleProps): JSX.Element {
  const { t } = useTranslation();
  const tc = (key: string, opts?: Record<string, unknown>): string =>
    t(`admin.patients.detail.conversation.handle.${key}`, opts);
  const tp = (key: string): string => t(`admin.patients.detail.conversation.panel.${key}`);
  const myUid = useAdminAuthStore((s) => s.authz?.uid) ?? '';

  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const lastReadAtRef = useRef<string>(new Date(0).toISOString());
  /** `MessageComposer` ATIVO (topo ou reply) — ver docstring do componente. */
  const composerRef = useRef<MessageComposerHandle>(null);

  const isUnreadFromOther = (message: ConversationMessage): boolean =>
    message.authorUid !== myUid && message.createdAt > lastReadAtRef.current;

  usePolling(async () => {
    try {
      const { messages } = await AdminConversationApiService.getConversation(patientId);
      const topUnread = messages.filter(isUnreadFromOther).length;

      // Réplicas (D-10, "topo + replies"): só busca as threads com atividade NOVA desde o
      // baseline — evita N chamadas por poll quando nada mudou na thread.
      const threadsWithNewActivity = messages.filter(
        (m) => m.lastReplyAt !== null && m.lastReplyAt > lastReadAtRef.current,
      );
      const replyBatches = await Promise.all(
        threadsWithNewActivity.map((m) => AdminConversationApiService.getConversationReplies(patientId, m.id)),
      );
      const repliesUnread = replyBatches.reduce(
        (acc, replies) => acc + replies.filter(isUnreadFromOther).length,
        0,
      );

      setUnreadCount(topUnread + repliesUnread);
    } catch {
      // Silencioso de propósito: o badge é um indicador secundário — falha de poll não é canal
      // de alerta (a regra "aviso operacional só por canal oficial" não se aplica a isto).
    }
  }, POLL_MS, { pauseWhenHidden: true });

  const handleOpen = (): void => {
    lastReadAtRef.current = new Date().toISOString();
    setUnreadCount(0);
    setIsPanelOpen(true);
  };

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
        onClick={handleOpen}
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
        />
      </SlideOverPanel>
    </>
  );
}
