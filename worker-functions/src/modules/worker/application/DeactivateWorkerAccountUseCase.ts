import { Pool } from 'pg';
import { RegisterOptOutUseCase } from '../../notification/application/RegisterOptOutUseCase';

export interface DeactivateWorkerAccountInput {
  workerId: string;
  /** Origem, propagada ao opt-out (default 'luz_conversation'). */
  source?: string;
}

export interface DeactivateWorkerAccountResult {
  ok: boolean;
  /** true se a conta já estava DISABLED (idempotente). */
  alreadyDisabled: boolean;
}

/**
 * "Dar de baja la cuenta" — direito à baixa (LGPD / Ley 25.326): desativa a conta
 * do worker A PEDIDO dele. É REVERSÍVEL (status volta a REGISTERED recalculando) e
 * AUDITADO (transação com `app.current_uid` → trigger de histórico, mesmo caminho do
 * `EncuadreController.updateWorkerStatus`).
 *
 * Faz DUAS coisas, atômicas do ponto de vista do usuário:
 *   1. `status = 'DISABLED'` → exclui de matching/convites e bloqueia o funil.
 *   2. registra o opt-out (reusa RegisterOptOutUseCase) → para o contato na hora.
 *
 * NÃO apaga dados (erasure é processo jurídico à parte, com retenção legal).
 */
export class DeactivateWorkerAccountUseCase {
  /** Marcador de ator no histórico — deixa claro que foi a Luz, a pedido do usuário. */
  private static readonly AUDIT_UID = 'luz:baja-cuenta';

  constructor(
    private readonly db: Pool,
    private readonly optOut: RegisterOptOutUseCase,
  ) {}

  async execute(
    input: DeactivateWorkerAccountInput,
  ): Promise<DeactivateWorkerAccountResult> {
    const source = input.source ?? 'luz_conversation';

    const check = await this.db.query<{ status: string }>(
      `SELECT status FROM workers WHERE id = $1 LIMIT 1`,
      [input.workerId],
    );
    if (check.rows.length === 0) {
      return { ok: false, alreadyDisabled: false };
    }
    const alreadyDisabled = check.rows[0].status === 'DISABLED';

    if (!alreadyDisabled) {
      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        // app.current_uid alimenta o trigger de histórico (auditoria de quem mudou).
        await client.query(`SELECT set_config('app.current_uid', $1, true)`, [
          DeactivateWorkerAccountUseCase.AUDIT_UID,
        ]);
        await client.query(
          `UPDATE workers SET status = 'DISABLED', updated_at = NOW() WHERE id = $1`,
          [input.workerId],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    // Para o contato na hora (belt-and-suspenders além do DISABLED). Fonte única.
    // reason='user_request' (é pedido do próprio worker; a CHECK constraint de
    // messaging_opt_out só aceita user_request|admin|undelivered_cap|no_response).
    // A distinção "baixa de conta" fica no source e no status=DISABLED.
    await this.optOut.execute({
      workerId: input.workerId,
      reason: 'user_request',
      source,
    });

    return { ok: true, alreadyDisabled };
  }
}
