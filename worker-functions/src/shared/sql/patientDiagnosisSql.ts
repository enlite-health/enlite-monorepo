/**
 * Fragmentos SQL únicos do "diagnóstico CID-11 ATIVO" do paciente (pedido do Javier) — molde de
 * `serviceScheduleSql`. "Ativo" = `patient_diagnoses.active`, de QUALQUER `source`
 * (PANEL, CLICKUP, BACKFILL). Só existência/contagem: o VALOR (texto clínico) nunca é selecionado.
 * Todo leitor SQL da regra usa estes fragmentos; nenhum reescreve o `pdx.active`.
 */

/** Nº de diagnósticos ativos do paciente cujo id é `patientIdExpr` (ex.: `p.id`). */
export function activeDiagnosisCountSql(patientIdExpr: string): string {
  return `(SELECT COUNT(*) FROM patient_diagnoses pdx WHERE pdx.patient_id = ${patientIdExpr} AND pdx.active)`;
}

/** ≥1 diagnóstico ativo do paciente `patientIdExpr` (boolean). */
export function hasActiveDiagnosisSql(patientIdExpr: string): string {
  return `EXISTS (SELECT 1 FROM patient_diagnoses pdx WHERE pdx.patient_id = ${patientIdExpr} AND pdx.active)`;
}
