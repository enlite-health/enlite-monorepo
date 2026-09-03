/**
 * patient-detail-b-helper.ts — semeadura e leitura direta no Postgres do docker para o e2e da
 * spec 012 (bloco B). Dados SINTÉTICOS; KMS em passthrough base64 (NODE_ENV=test na API).
 * Molde: patient-detail-a-helper.ts.
 */
import { insertTestPatient } from './db-test-helper';
import { runSQL, cleanupPatientDeep } from './patient-detail-a-helper';

export { runSQL, cleanupPatientDeep };

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** Paciente que já passou pela admissão (ACTIVE → admission_status DONE pelo trigger da 313), com 1 responsável. */
export function seedActivePatient(): { patientId: string; stamp: string } {
  const stamp = Date.now().toString().slice(-6);
  const { patientId } = insertTestPatient({ status: 'ACTIVE', firstName: 'BlocoB', lastName: `Activo${stamp}`, withAddress: true });
  runSQL(`INSERT INTO patient_responsibles (patient_id, first_name, last_name, relationship, phone_encrypted, is_primary, display_order, source) VALUES ('${patientId}', 'Marta', 'Resp${stamp}', 'OTHER', '${b64('+5491100000021')}', true, 1, 'admin_manual')`);
  return { patientId, stamp };
}

/** Paciente ainda no funil (PENDING_ADMISSION), SEM endereço — é o que o fluxo "domicílio na ficha → ativar" precisa. */
export function seedAdmissionPatient(): { patientId: string; stamp: string } {
  const stamp = Date.now().toString().slice(-6);
  const { patientId } = insertTestPatient({ status: 'PENDING_ADMISSION', firstName: 'BlocoB', lastName: `Admision${stamp}`, withAddress: false });
  runSQL(`UPDATE patients SET case_number = ${900000 + Number(stamp) % 90000}, phone_whatsapp = '+5491100000044' WHERE id = '${patientId}'`);
  return { patientId, stamp };
}

export function readPatientStatus(patientId: string): { status: string; admissionStatus: string; onHoldReason: string; onHoldNote: string } {
  const out = runSQL(`SELECT status || '|' || admission_status || '|' || COALESCE(on_hold_reason,'<NULL>') || '|' || COALESCE(on_hold_note,'<NULL>') FROM patients WHERE id = '${patientId}'`);
  const [status, admissionStatus, onHoldReason, onHoldNote] = out.split('|');
  return { status, admissionStatus, onHoldReason, onHoldNote };
}

export function readHistoryTop(patientId: string): { from: string; to: string; source: string } {
  const out = runSQL(`SELECT COALESCE(old_value,'<NULL>') || '|' || new_value || '|' || COALESCE(change_source,'<NULL>') FROM patient_status_history WHERE patient_id = '${patientId}' ORDER BY created_at DESC, id DESC LIMIT 1`);
  const [from, to, source] = out.split('|');
  return { from, to, source };
}

export function readAddresses(patientId: string): Array<{ formatted: string; neighborhood: string; corridor: string; access: string; country: string }> {
  const out = runSQL(`SELECT COALESCE(address_formatted,'<NULL>') || '|' || COALESCE(neighborhood,'<NULL>') || '|' || COALESCE(logistics_corridor,'<NULL>') || '|' || COALESCE(access_notes,'<NULL>') || '|' || country FROM patient_addresses WHERE patient_id = '${patientId}' AND archived_at IS NULL ORDER BY display_order`);
  return out ? out.split('\n').map((l) => { const [formatted, neighborhood, corridor, access, country] = l.split('|'); return { formatted, neighborhood, corridor, access, country }; }) : [];
}

export function readInsuranceCodes(patientId: string): string[] {
  const out = runSQL(`SELECT string_agg(provider_code || ':' || source, ',' ORDER BY ordinal) FROM patient_insurance_verified WHERE patient_id = '${patientId}'`);
  return out ? out.split(',') : [];
}

export function readDeviceTypes(patientId: string): { set: string[]; scalar: string } {
  const set = runSQL(`SELECT string_agg(device_type, ',' ORDER BY device_type) FROM patient_device_types WHERE patient_id = '${patientId}'`);
  const scalar = runSQL(`SELECT COALESCE(device_type,'<NULL>') FROM patients WHERE id = '${patientId}'`);
  return { set: set ? set.split(',') : [], scalar };
}

export function readRelationship(patientId: string): string {
  return runSQL(`SELECT COALESCE(relationship,'<NULL>') FROM patient_responsibles WHERE patient_id = '${patientId}' AND is_primary = true`);
}

export function readBirthAndServiceStart(patientId: string): { birthDate: string; serviceStartDate: string } {
  const out = runSQL(`SELECT COALESCE(birth_date::text,'<NULL>') || '|' || COALESCE(service_start_date::text,'<NULL>') FROM patients WHERE id = '${patientId}'`);
  const [birthDate, serviceStartDate] = out.split('|');
  return { birthDate, serviceStartDate };
}

export function findPatientIdByFirstName(firstName: string): string {
  return runSQL(`SELECT id FROM patients WHERE first_name = '${firstName}' ORDER BY created_at DESC LIMIT 1`);
}

export function countVacancies(patientId: string): number {
  return Number(runSQL(`SELECT count(*) FROM job_postings WHERE patient_id = '${patientId}' AND deleted_at IS NULL`));
}
