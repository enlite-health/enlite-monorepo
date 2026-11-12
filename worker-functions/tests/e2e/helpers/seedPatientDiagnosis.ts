/**
 * Semeia UM diagnóstico CID-11 sintético em `patient_diagnoses` — para os e2e que tiram o paciente
 * de ADMISSION (ou ativam recrutamento nele) e, desde o pedido do Javier, precisam de ≥1 diagnóstico
 * ATIVO para passar na trava (`DIAGNOSIS`, `PatientCompleteness.ts`).
 *
 * O título é sintético de propósito (nenhum texto clínico real). `source` aceita os três valores do
 * CHECK da migration 325 — a trava vale para QUALQUER origem. `active=false` grava `ended_at` (CHECK
 * `pd_active_ended_coerente`), para o caso "só diagnóstico inativo NÃO conta".
 */
import type { Pool } from 'pg';

export type DiagnosisSource = 'PANEL' | 'CLICKUP' | 'BACKFILL';

export async function seedPatientDiagnosis(
  pool: Pick<Pool, 'query'>,
  patientId: string,
  opts: { source?: DiagnosisSource; active?: boolean; code?: string } = {},
): Promise<void> {
  const { source = 'PANEL', active = true, code = '6A02' } = opts;
  await pool.query(
    `INSERT INTO patient_diagnoses
       (patient_id, terminology_system, concept_uri, concept_code, concept_title, concept_language,
        concept_group, catalog_release, source, is_primary, active, ended_at, created_by, updated_by)
     VALUES ($1, 'ICD-11', $2, $3, 'Diagnóstico sintético e2e', 'es', '06', '2026-01', $4, $5, $6,
             CASE WHEN $6 THEN NULL ELSE NOW() END, 'e2e', 'e2e')`,
    [patientId, `http://id.who.int/icd/release/11/e2e-sintetico/${code}`, code, source, active, active],
  );
}
