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
 *
 * 🔒 Achado do gate revisao-pr (r2): o `immediate: true` do `usePolling` só roda no efeito de
 * MONTE, cujas deps `[ms, pauseWhenHidden, immediate]` NÃO incluem `enabled` — carregamento a frio
 * (F5, ou link direto pra `/admin/...` já logado) monta este hook com `enabled=false` porque o
 * `adminAuthStore` ainda não resolveu (`adminProfile` null / `isLoading` true nesse instante). O
 * `immediate` do `usePolling` dispara e vira no-op ali mesmo, mas o efeito nunca roda de novo
 * quando `enabled` passa a `true` (o componente que hospeda o hook não desmonta — só re-renderiza)
 * — sem o `useEffect` abaixo, o 1º heartbeat real só sairia no próximo intervalo de 60s, e a
 * pessoa aparece offline até lá. Decisão: NÃO tocar em `usePolling` (compartilhado com sino e
 * conversa — mudar suas deps arrisca ripple nos outros callers); em vez disso, um efeito PRÓPRIO
 * aqui observa só a transição `false→true` e dispara o heartbeat imediato nesse momento. Ele NÃO
 * duplica quando já monta com `enabled=true` (o `wasEnabledRef` nasce igual ao `enabled` inicial,
 * então o 1º disparo desse efeito não vê transição) nem dispara em `true→false` (logout).
 */
import { useEffect, useRef } from 'react';
import { usePolling } from '@hooks/usePolling';
import { AdminPresenceApiService } from '@infrastructure/http/AdminPresenceApiService';

const HEARTBEAT_MS = 60000;

function sendHeartbeat(): void {
  void AdminPresenceApiService.heartbeat().catch(() => {
    // Best-effort — ver docstring acima.
  });
}

export function usePresenceHeartbeat(enabled = true): void {
  usePolling(() => {
    if (!enabled) return;
    sendHeartbeat();
  }, HEARTBEAT_MS, { immediate: true });

  const wasEnabledRef = useRef(enabled);
  useEffect(() => {
    const wasEnabled = wasEnabledRef.current;
    wasEnabledRef.current = enabled;
    if (!wasEnabled && enabled) {
      sendHeartbeat();
    }
  }, [enabled]);
}
