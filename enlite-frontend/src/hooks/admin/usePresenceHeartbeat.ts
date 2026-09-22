/**
 * usePresenceHeartbeat — presença simples (spec 022, Rodada 2/R2-F). Decisão do Gabriel (22/09):
 * "painel admin aberto manda heartbeat a cada ~60s, servidor grava só `last_seen_at`". Monta UMA
 * vez no `AdminLayout` — a mesma régua de `NotificationBell`/`PatientConversationHandle`:
 * `pauseWhenHidden` (aba em background não gasta heartbeat contra a API de produção).
 *
 * Best-effort: falha de heartbeat (rede, 401 expirado, 500) nunca vira erro visível nem interrompe
 * o painel — presença não é canal de alerta (mesma decisão do badge de notificação/conversa).
 */
import { usePolling } from '@hooks/usePolling';
import { AdminPresenceApiService } from '@infrastructure/http/AdminPresenceApiService';

const HEARTBEAT_MS = 60000;

export function usePresenceHeartbeat(): void {
  usePolling(() => {
    void AdminPresenceApiService.heartbeat().catch(() => {
      // Best-effort — ver docstring acima.
    });
  }, HEARTBEAT_MS, { pauseWhenHidden: true });
}
