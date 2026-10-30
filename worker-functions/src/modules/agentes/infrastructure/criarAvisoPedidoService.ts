import type { Pool } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { systemActor } from '@shared/audit/actorSource';
import { reportError } from '@shared/logging';
import { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import { AvisoPedidoService, lerConfigAviso, type AvisoWhatsappPort } from '../application/AvisoPedidoService';
import { PostgresAvisosRegistro } from './PostgresAvisosRegistro';
import { resolverDecisoresPedidosIa } from './DecisoresPedidosIa';

/** Composition root do aviso: o ator das escritas é `system:mcp:sol-fila` (a fila é quem deposita e quem reenvia). */
export function criarAvisoPedidoService(pool: Pool, whatsapp: AvisoWhatsappPort): AvisoPedidoService {
  return new AvisoPedidoService({
    decisores: resolverDecisoresPedidosIa,
    inapp: new SystemNotificationPublisher(),
    whatsapp,
    registro: new PostgresAvisosRegistro(),
    tx: (fn) => withActorContext(pool, fn, systemActor('mcp:sol-fila')),
    config: () => lerConfigAviso(),
    // Só a fonte: a mensagem do erro pode ecoar o número.
    onErro: (err, fonte) => reportError(err instanceof Error ? new Error(err.name) : new Error('erro'), { source: fonte }),
  });
}
