/**
 * terminology-diagnosis-helper.ts — semeadura e leitura direta no Postgres do docker para o
 * e2e da spec 016 F3 (front do diagnóstico CID-11). Dados SINTÉTICOS. Molde:
 * patient-detail-b-helper.ts.
 */
import { insertTestPatient } from './db-test-helper';
import { runSQL, cleanupPatientDeep } from './patient-detail-a-helper';

export { runSQL, cleanupPatientDeep };

/** Paciente ATIVO, pronto para abrir a ficha e editar a seção clínica. */
export function seedPatientForDiagnosis(): { patientId: string; stamp: string } {
  const stamp = Date.now().toString().slice(-6);
  const { patientId } = insertTestPatient({ status: 'ACTIVE', firstName: 'CID11F3', lastName: `Paciente${stamp}` });
  return { patientId, stamp };
}

export interface PatientDiagnosisRow {
  conceptCode: string;
  conceptTitle: string;
  conceptUri: string;
  isPrimary: boolean;
  active: boolean;
  source: string;
}

/** Lê as linhas de `patient_diagnoses` do paciente — a prova de que o código foi gravado. */
export function readPatientDiagnoses(patientId: string): PatientDiagnosisRow[] {
  const out = runSQL(
    `SELECT concept_code || '|' || concept_title || '|' || concept_uri || '|' || is_primary || '|' || active || '|' || source ` +
      `FROM patient_diagnoses WHERE patient_id = '${patientId}' ORDER BY created_at`,
  );
  if (!out) return [];
  return out.split('\n').map((line) => {
    const [conceptCode, conceptTitle, conceptUri, isPrimary, active, source] = line.split('|');
    // `||` concatena boolean como TEXTO SQL ("true"/"false") — NÃO é o "t"/"f" que o psql
    // mostra quando a coluna sai crua (sem concatenar). Comparar com 't' aqui sempre dava false.
    return { conceptCode, conceptTitle, conceptUri, isPrimary: isPrimary === 'true', active: active === 'true', source };
  });
}

/** US-4: promove/despromove o release `2026-01` — controla o 503 do catálogo (spec 016). */
export function setCatalogPromoted(promoted: boolean): void {
  if (promoted) {
    runSQL(
      `UPDATE terminology.icd_releases SET is_current = true, promoted_at = now(), promoted_by = 'f3-e2e' WHERE release = '2026-01'`,
    );
  } else {
    runSQL(
      `UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE release = '2026-01'`,
    );
  }
}

export function isCatalogPromoted(): boolean {
  return runSQL(`SELECT is_current FROM terminology.icd_releases WHERE release = '2026-01'`) === 't';
}
