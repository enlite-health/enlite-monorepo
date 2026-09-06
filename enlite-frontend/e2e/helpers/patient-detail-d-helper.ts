/**
 * patient-detail-d-helper.ts — semeadura e leitura direta no Postgres do docker para o e2e da
 * spec 014 (bloco D). Dados SINTÉTICOS; KMS em passthrough base64 (NODE_ENV=test na API).
 * Molde: patient-detail-a-helper.ts / patient-detail-c-helper.ts.
 */
import { insertTestPatient } from './db-test-helper';
import { runSQL, cleanupPatientDeep } from './patient-detail-a-helper';

export { runSQL, cleanupPatientDeep };

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/**
 * Paciente MAIOR (adulto), PENDING_ADMISSION, sem domicílio/cobertura/serviço/consentimento —
 * US-D1: o checklist deve listar ADDRESS · COVERAGE · CONTRACTED_SERVICE · CONSENT (RESPONSIBLE
 * não é exigido — não é menor).
 */
export function seedIncompletePatient(): { patientId: string; stamp: string } {
  const stamp = Date.now().toString().slice(-6);
  const { patientId } = insertTestPatient({
    status: 'PENDING_ADMISSION', firstName: 'BlocoD', lastName: `Incompleto${stamp}`,
    withAddress: false,
  });
  runSQL(`UPDATE patients SET birth_date = '1985-01-01', case_number = ${900000 + Number(stamp) % 90000} WHERE id = '${patientId}'`);
  return { patientId, stamp };
}

/**
 * Paciente com `phone_whatsapp` coincidindo (últimos 8 dígitos) com o telefone do responsável —
 * lex D3.1: dispara o aviso "este número coincide con el del responsable X". Já com
 * domicílio/cobertura/consentimento/serviço para o aviso ser o ÚNICO item novo na tela (sem o
 * checklist de completude competindo pela atenção do teste).
 */
export function seedPhoneMatchPatient(): { patientId: string; stamp: string; responsibleName: string; phone: string } {
  const stamp = Date.now().toString().slice(-6);
  const phone = `+549115126${stamp}`; // 8 dígitos finais únicos por rodada
  const { patientId } = insertTestPatient({
    status: 'PENDING_ADMISSION', firstName: 'BlocoD', lastName: `TelefonoCoincide${stamp}`,
    withAddress: true, hasConsent: true, insuranceInformed: 'OSDE',
  });
  const responsibleFirst = 'Marta';
  const responsibleLast = `RespD${stamp}`;
  runSQL(`UPDATE patients SET phone_whatsapp = '${phone}' WHERE id = '${patientId}'`);
  runSQL(`INSERT INTO patient_responsibles (patient_id, first_name, last_name, relationship, phone_encrypted, is_primary, display_order, source) VALUES ('${patientId}', '${responsibleFirst}', '${responsibleLast}', 'PARENT', '${b64(phone)}', true, 1, 'admin_manual')`);
  return { patientId, stamp, responsibleName: `${responsibleFirst} ${responsibleLast}`, phone };
}

/** Lê `phone_whatsapp` cru (coluna não-cifrada) — prova de que "Mantener" nunca grava nada. */
export function readPatientPhone(patientId: string): string | null {
  const out = runSQL(`SELECT COALESCE(phone_whatsapp, '<NULL>') FROM patients WHERE id = '${patientId}'`);
  return out === '<NULL>' ? null : out;
}

/** Lê o telefone (decriptado, passthrough base64) do responsável primário — confere que "Mantener" nunca o toca. */
export function readResponsiblePhone(patientId: string): string | null {
  const out = runSQL(`SELECT convert_from(decode(phone_encrypted, 'base64'), 'UTF8') FROM patient_responsibles WHERE patient_id = '${patientId}' AND is_primary LIMIT 1`);
  return out || null;
}
