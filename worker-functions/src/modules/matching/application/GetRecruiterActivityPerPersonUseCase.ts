/**
 * GetRecruiterActivityPerPersonUseCase (spec 081, T064b, D602a)
 *
 * Atividade do funil POR RECRUTADORA e SEMANA — só contagens. Irmão (não substituto) do
 * `GetFunnelActivityStatsUseCase`, que agrupa por ator (staff + Luz + sistema), janela única e devolve
 * e-mail. Aqui:
 *   - mesmas três fontes e mesmas condições de autoria do irmão (`changed_by` com prefixo `staff:`);
 *   - SÓ atores `staff:<uid>`: Luz, sistema, sync, o próprio prestador e linha sem autor ficam FORA;
 *   - agrupado por (uid, semana segunda-a-domingo em America/Argentina/Buenos_Aires);
 *   - a saída NÃO tem e-mail, nome, rótulo, worker_id nem a identidade crua (`staff:...`): só o uid opaco.
 *
 * Trilha de edição de cadastro (`worker_profile_changes_audit`): hoje grava a FONTE (`admin_panel`), não o
 * uid — então `profileEdits` por pessoa só aparece quando a trilha passar a gravar `staff:<uid>`. O irmão
 * mapeia `admin_panel` para o pseudo-ator `staff:cadastro-painel`, que NÃO é uid e aqui não entra.
 *
 * Defesa: `staff:<e-mail>` (fallback de `staffActor` quando não há uid) é excluído — e-mail nunca sai.
 */
import type { Pool } from 'pg';
import { workerNotTestSql } from '@shared/database/testRealmSql';

export const ACTIVITY_TIMEZONE = 'America/Argentina/Buenos_Aires';
export const ACTIVITY_WEEKS_MIN = 1;
export const ACTIVITY_WEEKS_MAX = 12;
export const ACTIVITY_WEEKS_DEFAULT = 4;

export interface RecruiterWeekActivity {
  /** firebase_uid opaco da recrutadora. */
  staffUid: string;
  /** Segunda-feira da semana, YYYY-MM-DD (America/Argentina/Buenos_Aires). */
  weekStart: string;
  funnelMoves: number;
  statusChanges: number;
  profileEdits: number;
  totalActions: number;
  /** Prestadores distintos tocados na semana. */
  workers: number;
}

export interface RecruiterActivityResult {
  weeks: number;
  rows: RecruiterWeekActivity[];
}

interface Row {
  staff_uid: string;
  week_start: string;
  funnel_moves: number;
  status_changes: number;
  profile_edits: number;
  workers: number;
}

export class GetRecruiterActivityPerPersonUseCase {
  constructor(private readonly pool: Pool) {}

  /** `now` existe só para o teste fixar o relógio. */
  async execute(input: { weeks: number; now?: Date }): Promise<RecruiterActivityResult> {
    const now = input.now ?? new Date();
    const { rows } = await this.pool.query<Row>(
      `WITH limite AS (
         -- segunda-feira (BA) da semana mais antiga da janela, como instante absoluto
         SELECT (date_trunc('week', $2::timestamptz AT TIME ZONE '${ACTIVITY_TIMEZONE}')
                 - make_interval(weeks => $1 - 1)) AT TIME ZONE '${ACTIVITY_TIMEZONE}' AS desde
       ),
       acoes AS (
         SELECT h.changed_by AS actor, wja.worker_id, h.created_at, 'funnel'::text AS kind
           FROM worker_job_application_stage_history h
           JOIN worker_job_applications wja ON wja.id = h.application_id, limite
          WHERE h.created_at >= limite.desde AND h.created_at <= $2

         UNION ALL

         SELECT s.changed_by, s.worker_id, s.created_at, 'status'
           FROM worker_status_history s, limite
          WHERE s.created_at >= limite.desde AND s.created_at <= $2

         UNION ALL

         SELECT a.changed_by, a.worker_id, a.created_at, 'profile'
           FROM worker_profile_changes_audit a, limite
          WHERE a.created_at >= limite.desde AND a.created_at <= $2
       )
       SELECT substring(actor from 7)                                              AS staff_uid,
              to_char(date_trunc('week', created_at AT TIME ZONE '${ACTIVITY_TIMEZONE}'), 'YYYY-MM-DD') AS week_start,
              COUNT(*) FILTER (WHERE kind = 'funnel')::int                         AS funnel_moves,
              COUNT(*) FILTER (WHERE kind = 'status')::int                         AS status_changes,
              COUNT(*) FILTER (WHERE kind = 'profile')::int                        AS profile_edits,
              COUNT(DISTINCT worker_id)::int                                       AS workers
         FROM acoes
        WHERE actor LIKE 'staff:%'
          AND length(substring(actor from 7)) > 0
          AND substring(actor from 7) !~ '[@:]'
          AND ${workerNotTestSql('acoes.worker_id')}
        GROUP BY 1, 2
        ORDER BY 2 DESC, 1 ASC`,
      [input.weeks, now],
    );

    return {
      weeks: input.weeks,
      rows: rows.map((r) => ({
        staffUid: r.staff_uid,
        weekStart: r.week_start,
        funnelMoves: r.funnel_moves,
        statusChanges: r.status_changes,
        profileEdits: r.profile_edits,
        totalActions: r.funnel_moves + r.status_changes + r.profile_edits,
        workers: r.workers,
      })),
    };
  }
}
