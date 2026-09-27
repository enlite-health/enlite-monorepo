/**
 * liveVacancySql — fonte ÚNICA do fragmento SQL da "vaga viva" de um serviço contratado
 * (Spec 018, PR-6): 1 vaga por serviço (`DISTINCT ON`), nunca deletada (`deleted_at IS NULL`),
 * a MAIS ANTIGA (`ORDER BY …, created_at ASC`) — a MESMA condição do 409 de
 * `ActivateRecruitmentUseCase`.
 *
 * Antes desta extração havia 2 cópias da condição: `ContractedServiceDetailMapper.ts` (ficha) e
 * `PatientKanbanServicesReader.ts` (Kanban) — achado 🟡 #5 do gate parcial da Fase 8. `whereExtra`
 * é a única parte que varia entre os dois chamadores (o filtro de QUAIS serviços entram); o resto
 * — colunas, `DISTINCT ON`, `deleted_at IS NULL`, ordenação — é fixo e idêntico nos dois.
 *
 * A 3ª versão da condição, pré-existente e DIFERENTE (`PatientContractedServiceRepository.ts:195`,
 * `LIMIT 1` sem `ORDER BY` — pode devolver uma vaga qualquer, não a mais antiga), NÃO entra aqui —
 * ver LISTA do retorno G1.
 */
export function liveVacancySelect(whereExtra: string): string {
  return `SELECT DISTINCT ON (jp.contracted_service_id) jp.contracted_service_id, jp.id
            FROM job_postings jp
           WHERE jp.deleted_at IS NULL AND ${whereExtra}
           ORDER BY jp.contracted_service_id, jp.created_at ASC`;
}
