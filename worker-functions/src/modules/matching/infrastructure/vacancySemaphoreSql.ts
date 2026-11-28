/**
 * vacancySemaphoreSql — o DONO de `n` do semáforo da vaga (semaforo-da-vaga, F1, D811 + P3).
 *
 * `n` = quantos prestadores ocupam a vaga = cards das colunas "Seleccionado" + "Equipo de Respuesta Rápida" do
 * Kanban da vaga (`WJAFunnelController`), MENOS quem tem marca de saída ATIVA no serviço da vaga (P3).
 * Os predicados do card são os MESMOS helpers que o controller usa — importados, nunca copiados:
 *   - `excludeDisabledWorkersSql('w')`   (conta dada de baixa não aparece)
 *   - `sameRealmAsVacancySql`            (worker e vaga no mesmo realm)
 *   - `wjaSupersededByBlockedSql('wja')` (convite substituído por tentativa bloqueada some)
 * O alocado ("En atención") CONTA. Fragmento correlacionado por `job_postings.id`: a lista de vagas e o
 * leitor em lote do Kanban de pacientes leem a MESMA expressão; a cor sai de `corDoSemaforoSql` (domínio).
 */
import { excludeDisabledWorkersSql } from '@shared/database/activeWorkerFilter';
import { sameRealmAsVacancySql } from '@shared/database/testRealmSql';
import { FILLED_POSITION_STAGES, toSqlInList } from '../domain/applicationFunnelStages';
import { wjaSupersededByBlockedSql } from './BlockedApplicationQueryRepository';

const FILLED_POSITION_SQL = toSqlInList(FILLED_POSITION_STAGES);

/**
 * Subquery escalar `(SELECT COUNT(*) …)` com o `n` da vaga.
 * @param jpIdExpr expressão do id da vaga (ex.: `jp.id`).
 */
export function semaforoContagemSql(jpIdExpr: string): string {
  return `(SELECT COUNT(*)::int
      FROM worker_job_applications wja
      LEFT JOIN workers w ON w.id = wja.worker_id
     WHERE wja.job_posting_id = ${jpIdExpr}
       AND wja.application_funnel_stage IN (${FILLED_POSITION_SQL})
       AND ${excludeDisabledWorkersSql('w')}
       AND ${sameRealmAsVacancySql('wja.worker_id', 'wja.job_posting_id')}
       AND NOT ${wjaSupersededByBlockedSql('wja')}
       AND NOT EXISTS (
         SELECT 1
           FROM contracted_service_rejections csr
           JOIN job_postings jp_saida ON jp_saida.id = wja.job_posting_id
          WHERE csr.service_id = jp_saida.contracted_service_id
            AND csr.worker_id = wja.worker_id
            AND csr.reverted_at IS NULL
       ))`;
}
