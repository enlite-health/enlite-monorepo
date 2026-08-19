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
  oldest_stuck_since: Date | null;
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
   *
   * O RELÓGIO COMEÇA EM `eligible_since` — o instante em que o worker virou
   * REGISTERED —, NÃO em `workers.created_at`.
   *
   * `created_at` é quando a LINHA nasceu (em geral no signup, como
   * INCOMPLETE_REGISTER); o espelho só é disparado quando o cadastro fica
   * completo. Usar `created_at` errava nas DUAS direções, e as duas foram
   * observadas em produção em 18/08/2026:
   *
   *   - FALSO POSITIVO: quem se cadastra hoje e completa o registro dias depois
   *     nasce "preso há 148h" no segundo em que vira REGISTERED, e o alerta
   *     dispara ~4min depois — com o espelho funcionando e fechando normal em
   *     ~10min. Foram 2 páginas nesse dia, ambas auto-resolvidas. Ruído, que é
   *     justamente o defeito que esta policy existe para consertar.
   *
   *   - FALSO NEGATIVO (pior): quem se cadastrou há MAIS de `recencyWindowHours`
   *     e completa o registro hoje entra direto no balde `chronicTotal`, que por
   *     desenho NÃO pagina. Uma falha nova de espelho ficava classificada como
   *     "backlog histórico" e silenciosa — que é exatamente a forma do incidente
   *     de 30/07 (11 dias sem ninguém ver). Em 18/08, 2 dos 5 cadastros
   *     concluídos no dia caíam nesse ponto cego.
   *
   * `worker_status_history` é a fonte (344/346 REGISTERED de produção têm a
   * linha; os 2 sem são cadastros fundidos). O COALESCE preserva o
   * comportamento antigo para linhas importadas em massa, que não têm história.
   */
  async getMirrorHealth(
    stuckThresholdHours = 2,
    recencyWindowHours = 168,
  ): Promise<AnaCareMirrorHealth> {
    const { rows } = await this.pool.query<HealthQueryRow>(
      `
      WITH eligible AS (
        SELECT COALESCE(
                 (SELECT MAX(h.created_at)
                    FROM worker_status_history h
                   WHERE h.worker_id = w.id
                     AND h.field_name = 'status'
                     AND h.new_value = 'REGISTERED'),
                 w.created_at
               ) AS eligible_since
          FROM workers w
         WHERE w.status = 'REGISTERED'
           AND w.ana_care_id IS NULL
           AND w.deleted_at IS NULL
           AND COALESCE(w.is_test, false) = false
      )
      SELECT
        COUNT(*) FILTER (
          WHERE eligible_since <= NOW() - make_interval(hours => $1::int)
            AND eligible_since >  NOW() - make_interval(hours => $2::int)
        )::int AS stuck_recent,
        MIN(eligible_since) FILTER (
          WHERE eligible_since <= NOW() - make_interval(hours => $1::int)
            AND eligible_since >  NOW() - make_interval(hours => $2::int)
        ) AS oldest_stuck_since,
        COUNT(*) FILTER (
          WHERE eligible_since <= NOW() - make_interval(hours => $2::int)
        )::int AS chronic_total
      FROM eligible
      `,
      [stuckThresholdHours, recencyWindowHours],
    );

    const row = rows[0] ?? { stuck_recent: 0, oldest_stuck_since: null, chronic_total: 0 };

    return {
      stuckRecent: row.stuck_recent,
      oldestStuckAgeHours: computeOldestStuckAgeHours(row.oldest_stuck_since),
      chronicTotal: row.chronic_total,
      stuck: isMirrorStuck(row.stuck_recent),
    };
  }
}
