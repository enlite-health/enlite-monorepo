import type { Pool } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { systemActor } from '@shared/audit/actorSource';
import { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import type { AvisoAplicarPort } from '../application/PedidosIaUseCases';
import { resolverDecisoresPedidosIa } from './DecisoresPedidosIa';

/** Gatilho (d) (spec 078 M4.4): notificação in-app `PEDIDO_IA_APLICAR` aos decisores; ator das escritas = `system:mcp:sol-fila`, como o aviso do depósito. */
export class PedidoAplicarNotifier implements AvisoAplicarPort {
  constructor(private readonly pool: Pool, private readonly publisher = new SystemNotificationPublisher()) {}

  async notificar(i: { pedidoId: string; degrau: number; grave: boolean }): Promise<void> {
    await withActorContext(
      this.pool,
      async (c) => {
        const recipientUids = await resolverDecisoresPedidosIa(c);
        await this.publisher.publishPedidoIaAplicar(c, { ...i, recipientUids });
      },
      systemActor('mcp:sol-fila'),
    );
  }
}
