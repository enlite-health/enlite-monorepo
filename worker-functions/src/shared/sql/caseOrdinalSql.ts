/**
 * Spec 084 (R12/R16): `case_ordinal` = a ORDEM DO SERVIÇO contratado dentro do paciente (1..N, por created_at, id) — não MAX+1.
 * Vaga SEM serviço fica SEM número (NULL); vaga nova de um serviço repete o número do serviço. Fonte ÚNICA: tanto o INSERT da
 * vaga (`buildInsertQuery`, serviço em $23) quanto o VÍNCULO de uma vaga existente a um serviço
 * (`LinkExistingVacancyRepository.linkVacancyAndClear`) usam esta expressão — vincular sem recalcular deixaria o número antigo.
 */
export function caseOrdinalFromServiceSql(serviceParam: string): string {
  return `CASE WHEN ${serviceParam}::uuid IS NULL THEN NULL ELSE (
        SELECT s.ordinal FROM (
          SELECT id, row_number() OVER (PARTITION BY patient_id ORDER BY created_at, id)::int AS ordinal
            FROM patient_contracted_services
           WHERE patient_id = (SELECT patient_id FROM patient_contracted_services WHERE id = ${serviceParam}::uuid)
        ) s WHERE s.id = ${serviceParam}::uuid
      ) END`;
}
