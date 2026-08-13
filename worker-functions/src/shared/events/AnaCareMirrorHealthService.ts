import { Pool } from 'pg';
import { computeOldestStuckAgeHours, isMirrorStuck } from './anaCareMirrorHealthMath';

export interface AnaCareMirrorHealth {
  /** Workers elegíveis, dentro da janela de recência, presos além do limite. */
  stuckRecent: number;
  /** Idade (horas) do preso recente mais antigo. 0 quando não há nenhum. */
  oldestStuckAgeHours: number;
  /**
   * Presos MAIS VELHOS que a janela de recência. Backlog histórico que não
   * volta sozinho (erro de linking, evento nunca emitido). É REPORTADO para
   * ficar visível, mas NÃO pagina — senão o alerta nasce vermelho pra sempre
   * e vira ruído, que é exatamente o defeito que este arquivo conserta.
   */
  chronicTotal: number;
  stuck: boolean;
}

interface HealthQueryRow {
  stuck_recent: number;
  oldest_stuck_created_at: Date | null;
  chronic_total: number;
}

/**
 * Diagnóstico read-only do espelho worker -> Ana Care.
 *
 * POR QUE ISTO EXISTE, e não bastava o alerta de outbox:
 *
 * 1. `domain_event_delivery_failure` é alerta de BORDA — conta linhas de log de
 *    falha numa janela de 5min. Passada a rajada a métrica zera e o Monitoring
 *    manda "[RESOLVED] Alert recovered" com o sistema ainda quebrado. No
 *    incidente de 30/07 (chave da API do Ana Care invalidada) isso produziu
 *    ~201 pares ALERT/RESOLVED em 11 dias e afirmou ativamente que estava tudo
 *    bem.
 * 2. `domain_event_backlog_stuck` é cego a este modo de falha: `stuck` sai de
 *    `oldest_recent_created_at`, que filtra `status='pending'`. Os 197+ eventos
 *    do incidente estavam `status='failed'` — `failedTotal` é coletado e nunca
 *    entra na decisão.
 *
 * A pergunta certa não é "falhou agora?" e sim "existe prestador REGISTERED sem
 * ana_care_id há mais de X horas?" — um predicado de ESTADO, que permanece
 * verdadeiro enquanto o espelho estiver quebrado e só fica falso quando o
 * backlog realmente zera.
 *
 * Zero escrita. Uma query, sem PII: só contagens e um timestamp.
 */
export class AnaCareMirrorHealthService {
  constructor(private readonly pool: Pool) {}

  /**
   * @param stuckThresholdHours idade acima da qual um worker sem `ana_care_id` conta como preso
   * @param recencyWindowHours  idade acima da qual o preso é considerado backlog crônico (não pagina)
   */
  async getMirrorHealth(
    stuckThresholdHours = 2,
    recencyWindowHours = 168,
  ): Promise<AnaCareMirrorHealth> {
    const { rows } = await this.pool.query<HealthQueryRow>(
      `
      SELECT
        COUNT(*) FILTER (
          WHERE created_at <= NOW() - make_interval(hours => $1::int)
            AND created_at >  NOW() - make_interval(hours => $2::int)
        )::int AS stuck_recent,
        MIN(created_at) FILTER (
          WHERE created_at <= NOW() - make_interval(hours => $1::int)
            AND created_at >  NOW() - make_interval(hours => $2::int)
        ) AS oldest_stuck_created_at,
        COUNT(*) FILTER (
          WHERE created_at <= NOW() - make_interval(hours => $2::int)
        )::int AS chronic_total
      FROM workers
      WHERE status = 'REGISTERED'
        AND ana_care_id IS NULL
        AND deleted_at IS NULL
        AND COALESCE(is_test, false) = false
      `,
      [stuckThresholdHours, recencyWindowHours],
    );

    const row = rows[0] ?? { stuck_recent: 0, oldest_stuck_created_at: null, chronic_total: 0 };

    return {
      stuckRecent: row.stuck_recent,
      oldestStuckAgeHours: computeOldestStuckAgeHours(row.oldest_stuck_created_at),
      chronicTotal: row.chronic_total,
      stuck: isMirrorStuck(row.stuck_recent),
    };
  }
}
