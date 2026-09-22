import { registry } from '../registry';
import { ErrorResponseSchema } from '../schemas/common';

/**
 * `POST /api/admin/me/presence` — heartbeat de presença (change 022-ux-mencao-e-notificacao,
 * Rodada 2/R2-B). Molde: `adminNotifications.ts`.
 *
 * O painel admin ABERTO manda heartbeat a cada ~60s; o servidor grava só `last_seen_at` do
 * PRÓPRIO uid autenticado (nunca de outro) — sem histórico, sem corpo de request nem resposta.
 * Throttle no servidor: chamada repetida em menos de 30s é NO-OP silencioso — sempre 204 de
 * qualquer forma, o cliente nunca precisa saber se regravou.
 */
registry.registerPath({
  method: 'post',
  path: '/api/admin/me/presence',
  tags: ['Admin · Users'],
  summary: 'Heartbeat de presença do painel admin',
  description:
    'Marca o PRÓPRIO uid autenticado como "visto por último" agora (`users.last_seen_at`). Sem '
    + 'corpo de request. Throttle no servidor: só regrava se o valor atual tiver mais de 30s — '
    + 'transparente ao cliente (sempre 204). Exige `own_presence:update` (nasce concedida a todo '
    + 'staff ativo, mesma regra de `own_notifications`, D-07).',
  security: [{ firebaseAuth: [] }],
  responses: {
    204: { description: 'Heartbeat recebido (regravado ou não, por throttle — o cliente não distingue).' },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    403: { description: 'Sem a célula `own_presence:update`.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
