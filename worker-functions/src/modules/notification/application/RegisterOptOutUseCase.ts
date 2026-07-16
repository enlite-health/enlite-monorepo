import { Pool } from 'pg';

export interface RegisterOptOutInput {
  /** Um dos dois basta: workerId (canal Luz/MCP) OU phone (webhooks). */
  workerId?: string;
  /** Aceita "whatsapp:+NNN" ou "+NNN" — normalizado internamente. */
  phone?: string;
  /** Motivo persistido (default 'user_request'). */
  reason?: string;
  /** Origem da baixa: 'whatsapp_inbound' | 'periskope_inbound' | 'luz_conversation'… */
  source: string;
}

export interface RegisterOptOutResult {
  ok: boolean;
  workerId: string | null;
}

/**
 * Fonte ÚNICA da supressão POR PEDIDO do worker (opt-out).
 *
 * Resolve o worker por id OU por phone e grava `messaging_opt_out` com
 * `ON CONFLICT (worker_id) DO UPDATE` = re-opt-out (mesma semântica que já
 * vivia inline em InboundWhatsAppController.handleOptOut e
 * PeriskopeWebhookController.handleOptOut — agora unificada aqui).
 *
 * NÃO cobre o auto-bloqueio por falha de entrega (`undelivered_cap` /
 * `ON CONFLICT DO NOTHING`, TwilioWebhookController): política diferente
 * (não é pedido do worker, não deve sobrescrever um opt-in). Fica separado.
 */
export class RegisterOptOutUseCase {
  constructor(private readonly db: Pool) {}

  async execute(input: RegisterOptOutInput): Promise<RegisterOptOutResult> {
    const reason = input.reason ?? 'user_request';
    let workerId = input.workerId ?? null;
    let phone = input.phone ? input.phone.replace('whatsapp:', '').trim() : null;

    // Resolver o identificador que faltar.
    if (!workerId && phone) {
      const res = await this.db.query<{ id: string }>(
        `SELECT id FROM workers WHERE phone = $1 LIMIT 1`,
        [phone],
      );
      workerId = res.rows[0]?.id ?? null;
    } else if (workerId && !phone) {
      const res = await this.db.query<{ phone: string | null }>(
        `SELECT phone FROM workers WHERE id = $1 LIMIT 1`,
        [workerId],
      );
      phone = res.rows[0]?.phone ?? null;
    }

    // Sem worker conhecido = nada a suprimir (ex: telefone desconhecido).
    if (!workerId) {
      return { ok: false, workerId: null };
    }

    await this.db.query(
      `INSERT INTO messaging_opt_out (worker_id, phone, reason, source)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (worker_id)
       DO UPDATE SET opted_out_at = NOW(),
                     opted_in_at  = NULL,
                     reason       = EXCLUDED.reason,
                     source       = EXCLUDED.source`,
      [workerId, phone, reason, input.source],
    );

    return { ok: true, workerId };
  }
}
