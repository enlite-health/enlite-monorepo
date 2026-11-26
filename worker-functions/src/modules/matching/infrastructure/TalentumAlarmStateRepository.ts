import type { PoolClient } from 'pg';

export interface TalentumAlarmState {
  abertoDesde: Date;
  ultimoAvisoEm: Date | null;
  quantidade: number;
}

/** Porta do dedup do sino do webhook do Talentum (`talentum_webhook_alarm_state`, uma linha por alarme ABERTO). */
export interface ITalentumAlarmStateRepository {
  /** Lê a linha do alarme travando-a (`FOR UPDATE`): dois ciclos concorrentes não avisam em dobro. */
  lock(c: PoolClient, alarme: string): Promise<TalentumAlarmState | null>;
  /** Abre o alarme. `false` = outro ciclo já abriu (a linha existia): quem perdeu a corrida não avisa. */
  open(c: PoolClient, alarme: string, now: Date, quantidade: number): Promise<boolean>;
  /** Atualiza a quantidade; com `reminded`, carimba também `ultimo_aviso_em`. */
  touch(c: PoolClient, alarme: string, quantidade: number, reminded: Date | null): Promise<void>;
  /** Fecha (zera) o alarme. */
  close(c: PoolClient, alarme: string): Promise<void>;
}

export class TalentumAlarmStateRepository implements ITalentumAlarmStateRepository {
  async lock(c: PoolClient, alarme: string): Promise<TalentumAlarmState | null> {
    const { rows } = await c.query<{ aberto_desde: Date; ultimo_aviso_em: Date | null; quantidade: number }>(
      `SELECT aberto_desde, ultimo_aviso_em, quantidade FROM talentum_webhook_alarm_state WHERE alarme = $1 FOR UPDATE`,
      [alarme],
    );
    const r = rows[0];
    return r ? { abertoDesde: r.aberto_desde, ultimoAvisoEm: r.ultimo_aviso_em, quantidade: r.quantidade } : null;
  }

  async open(c: PoolClient, alarme: string, now: Date, quantidade: number): Promise<boolean> {
    const r = await c.query(
      `INSERT INTO talentum_webhook_alarm_state (alarme, aberto_desde, ultimo_aviso_em, quantidade) VALUES ($1, $2, $2, $3)
       ON CONFLICT (alarme) DO NOTHING`,
      [alarme, now, quantidade],
    );
    return (r.rowCount ?? 0) === 1;
  }

  async touch(c: PoolClient, alarme: string, quantidade: number, reminded: Date | null): Promise<void> {
    await c.query(
      `UPDATE talentum_webhook_alarm_state SET quantidade = $2, ultimo_aviso_em = COALESCE($3, ultimo_aviso_em) WHERE alarme = $1`,
      [alarme, quantidade, reminded],
    );
  }

  async close(c: PoolClient, alarme: string): Promise<void> {
    await c.query(`DELETE FROM talentum_webhook_alarm_state WHERE alarme = $1`, [alarme]);
  }
}
