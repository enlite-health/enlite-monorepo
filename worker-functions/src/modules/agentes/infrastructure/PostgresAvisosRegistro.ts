import type { PoolClient } from 'pg';
import type { AvisosRegistroPort, LinhaAviso } from '../application/AvisoPedidoService';

/** `agentes.avisos_enviados` (migration 553): INSERT e SELECT apenas. Tudo no `client` da transação de quem chama. */
export class PostgresAvisosRegistro implements AvisosRegistroPort {
  async registrar(c: PoolClient, l: LinhaAviso): Promise<void> {
    await c.query(
      `INSERT INTO agentes.avisos_enviados (pedido_id, canal, destinatario_ref, tentativa, template_ref, resultado, motivo)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [l.pedidoId, l.canal, l.destinatarioRef, l.tentativa, l.templateRef, l.resultado, l.motivo ?? null],
    );
  }

  async gravesSemDecisao(c: PoolClient, agora: Date, horas: number): Promise<string[]> {
    const { rows } = await c.query<{ id: string }>(
      `SELECT p.id
         FROM agentes.pedidos p
        WHERE p.grave_gatilho <> 'nenhum'
          AND p.criado_em <= $1::timestamptz - make_interval(secs => $2::double precision * 3600)
          AND NOT EXISTS (SELECT 1 FROM agentes.pedido_eventos e
                           WHERE e.pedido_id = p.id AND e.acao IN ('aceitar','negar','descrever'))
        ORDER BY p.criado_em, p.id`,
      [agora.toISOString(), horas],
    );
    return rows.map((r) => r.id);
  }

  async tentativasTwilio(c: PoolClient, pedidoId: string): Promise<Array<{ destinatarioRef: string; maxTentativa: number }>> {
    const { rows } = await c.query<{ destinatario_ref: string; max_t: number }>(
      `SELECT destinatario_ref, max(tentativa)::int AS max_t
         FROM agentes.avisos_enviados
        WHERE pedido_id = $1 AND canal = 'twilio'
        GROUP BY destinatario_ref ORDER BY destinatario_ref`,
      [pedidoId],
    );
    return rows.map((r) => ({ destinatarioRef: r.destinatario_ref, maxTentativa: r.max_t }));
  }
}
