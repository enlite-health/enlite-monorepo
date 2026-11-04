/**
 * vinculo-servico-helper.ts — o vínculo serviço → contrato que o portão `COVERAGE` lê (spec 087).
 *
 * Desde a 087 o foguete "Activar reclutamiento", o vínculo de vaga e a fusão exigem que o SERVIÇO tenha vínculo vigente (contrato ou
 * Particular) — não mais `patients.insurance_informed` nem `patient_insurance_verified`. Os e2e que só semeavam a informada para passar
 * no portão passam a vincular o serviço por aqui: obra social `PRIVATE` do catálogo (Particular conta como vínculo) + UM contrato fixo
 * por país (find-or-create, país lido do próprio serviço: o banco recusa vínculo de contrato de outro país). Nada a limpar: o vínculo
 * some junto com o serviço (ON DELETE CASCADE). Massa SINTÉTICA, nenhum dado de pessoa.
 */
import { runSQL } from './patient-detail-a-helper';

/** Vigência aberta desde 2020: cobre qualquer "hoje" de operação. */
export const VIGENCIA_ABERTA_E2E = '[2020-01-01,)';

/** Vincula o serviço ao contrato Particular do país dele. `valid` é um texto de daterange (ex.: `[2020-01-01,2020-02-01)` = encerrado). */
export function vincularServicoAoParticular(serviceId: string, valid: string = VIGENCIA_ABERTA_E2E): void {
  runSQL(`
    INSERT INTO insurance_contracts (provider_code, country, name, created_by, updated_by)
    SELECT 'PRIVATE', pcs.country, 'QA087 vínculo particular ' || pcs.country, 'qa087', 'qa087'
      FROM patient_contracted_services pcs WHERE pcs.id = '${serviceId}'
    ON CONFLICT (provider_code, lower(name)) DO NOTHING
  `);
  runSQL(`
    INSERT INTO contracted_service_contract (contracted_service_id, contract_id, valid, recorded_by)
    SELECT pcs.id, c.id, '${valid}'::daterange, 'qa087'
      FROM patient_contracted_services pcs
      JOIN insurance_contracts c ON c.provider_code = 'PRIVATE' AND lower(c.name) = lower('QA087 vínculo particular ' || pcs.country)
     WHERE pcs.id = '${serviceId}'
  `);
}

/** Encerra o vínculo vigente do serviço (o "estado muda por fora"): `valid` passa a terminar ontem... por substituição ENDED, como a API faz. */
export function encerrarVinculoDoServico(serviceId: string): void {
  runSQL(`
    UPDATE contracted_service_contract SET superseded_by = 'qa087', superseded_reason = 'ENDED'
     WHERE contracted_service_id = '${serviceId}' AND superseded_at IS NULL
  `);
}
