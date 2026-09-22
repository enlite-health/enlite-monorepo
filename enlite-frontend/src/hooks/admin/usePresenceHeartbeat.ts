/**
 * usePresenceHeartbeat — presença simples (spec 022, Rodada 2). Decisão do Gabriel (22/09):
 * "sessão ativa em QUALQUER LUGAR do app" manda heartbeat a cada ~60s, servidor grava só
 * `last_seen_at` (em `staff_presence`, tabela própria). Monta UMA vez em `AdminProtectedRoute` —
 * o ponto único onde o app decide "staff autenticado" (D268: envolve `AdminLayout` na raiz de
 * `/admin` e cobre TODA rota `/admin/*`, incluindo estados em que `AdminLayout` ainda não montou —
 * `AuthzLoading`/`WelcomeNoGroupPage` — que a posição antiga dentro do `AdminLayout` não cobria).
 *
 * SEM `pauseWhenHidden` (mudou nesta rodada): a decisão do Gabriel é "aba visível OU escondida" —
 * uma aba em background ainda conta como sessão ativa para fins de presença (diferente do
 * poll de notificação/conversa, que pausa para não gastar contra a API à toa).
 *
 * `immediate: true` (mudou nesta rodada): dispara ao montar/logar, sem esperar os 60s do 1º
 * intervalo — outras páginas do app (ex. lista de pacientes) precisam refletir presença assim
 * que o staff abre QUALQUER rota, não só depois de ficar 60s parado nela.
 *
 * Best-effort: falha de heartbeat (rede, 401 expirado, 500) nunca vira erro visível nem interrompe
 * o painel — presença não é canal de alerta (mesma decisão do badge de notificação/conversa).
 *
 * `enabled` (default `true`): quem chama (hoje, `AdminProtectedRoute`) passa `isAuthenticated &&
 * !!adminProfile` — o MESMO par de condições que decide se o componente renderiza o painel para o
 * staff. `false` faz o corpo do poll virar no-op (nunca chama a API) sem violar Rules of Hooks —
 * o hook precisa ser chamado incondicionalmente a cada render do componente que o hospeda, então
 * o "desligar" é por parâmetro, não por pular a chamada.
 */
import { usePolling } from '@hooks/usePolling';
import { AdminPresenceApiService } from '@infrastructure/http/AdminPresenceApiService';

const HEARTBEAT_MS = 60000;

export function usePresenceHeartbeat(enabled = true): void {
  usePolling(() => {
    if (!enabled) return;
    void AdminPresenceApiService.heartbeat().catch(() => {
      // Best-effort — ver docstring acima.
    });
  }, HEARTBEAT_MS, { immediate: true });
}
