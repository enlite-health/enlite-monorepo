/**
 * patient-detail-a-helper.ts — semeadura e leitura direta no Postgres do docker
 * para o e2e da spec 011 (bloco A). Dados SINTÉTICOS; KMS em passthrough
 * base64 (NODE_ENV=test na API do docker), por isso `encode/decode(..., 'base64')`.
 */
import { execSync } from 'child_process';
import { insertTestPatient } from './db-test-helper';

export function runSQL(sql: string): string {
  return execSync(
    `docker exec ${process.env.E2E_PG_CONTAINER || 'enlite-postgres'} psql -U enlite_admin -d enlite_e2e -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' },
  ).trim();
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

export interface BlocoASeed {
  patientId: string;
  addressFormatted: string;
  coverage: string;
  contactEmail: string;
  responsible: { firstName: string; lastName: string; phone: string; documentType: string; documentNumber: string; source: string };
  professional: { name: string; phone: string };
}

/** Paciente importado do ClickUp (clickup_task_id), com 1 responsável, 1 endereço, 1 profissional, cobertura e e-mail. */
export function seedPatientForBlocoA(): BlocoASeed {
  const stamp = Date.now().toString().slice(-6);
  const { patientId } = insertTestPatient({ status: 'ADMISSION', firstName: 'BlocoA', lastName: `Paciente${stamp}`, withAddress: true });
  const coverage = `OSDE 310 e2e ${stamp}`;
  const contactEmail = `paciente.${stamp}@example.test`;
  const responsible = { firstName: 'Marta', lastName: `Resp${stamp}`, phone: '+5491100000021', documentType: 'DNI', documentNumber: `22${stamp}`, source: 'web_form' };
  const professional = { name: `Dra. Tratante ${stamp}`, phone: '+5491100000022' };

  runSQL(`UPDATE patients SET health_insurance_name = '${coverage}', contact_email_encrypted = '${b64(contactEmail)}' WHERE id = '${patientId}'`);
  runSQL(`INSERT INTO patient_responsibles (patient_id, first_name, last_name, relationship, phone_encrypted, email_encrypted, document_number_encrypted, document_type, is_primary, display_order, source) VALUES ('${patientId}', '${responsible.firstName}', '${responsible.lastName}', 'PARENT', '${b64(responsible.phone)}', NULL, '${b64(responsible.documentNumber)}', '${responsible.documentType}', true, 1, '${responsible.source}')`);
  runSQL(`INSERT INTO patient_professionals (patient_id, name, phone_encrypted, email_encrypted, display_order, is_team) VALUES ('${patientId}', '${professional.name}', '${b64(professional.phone)}', NULL, 1, false)`);

  return { patientId, addressFormatted: 'Av. Corrientes 1234, CABA, AR', coverage, contactEmail, responsible, professional };
}

export interface ResponsibleRow { documentType: string; documentNumber: string; source: string; phone: string }

/** Lê o responsável primário já DECODIFICADO (passthrough base64). */
export function readPrimaryResponsible(patientId: string): ResponsibleRow {
  const out = runSQL(`SELECT COALESCE(document_type,'<NULL>') || '|' || COALESCE(convert_from(decode(document_number_encrypted,'base64'),'UTF8'),'<NULL>') || '|' || source || '|' || COALESCE(convert_from(decode(phone_encrypted,'base64'),'UTF8'),'<NULL>') FROM patient_responsibles WHERE patient_id = '${patientId}' AND is_primary = true`);
  const [documentType, documentNumber, source, phone] = out.split('|');
  return { documentType, documentNumber, source, phone };
}

export function readContactEmail(patientId: string): string {
  return runSQL(`SELECT COALESCE(convert_from(decode(contact_email_encrypted,'base64'),'UTF8'),'<NULL>') FROM patients WHERE id = '${patientId}'`);
}

export function readPatientCoverageColumns(patientId: string): { insuranceInformed: string; healthInsuranceName: string } {
  const out = runSQL(`SELECT COALESCE(insurance_informed,'<NULL>') || '|' || COALESCE(health_insurance_name,'<NULL>') FROM patients WHERE id = '${patientId}'`);
  const [insuranceInformed, healthInsuranceName] = out.split('|');
  return { insuranceInformed, healthInsuranceName };
}

export function findPatientIdByFirstName(firstName: string): string {
  return runSQL(`SELECT id FROM patients WHERE first_name = '${firstName}' ORDER BY created_at DESC LIMIT 1`);
}

export function cleanupPatientDeep(patientId: string): void {
  if (!patientId) return;
  runSQL(`DELETE FROM patient_professionals WHERE patient_id = '${patientId}'`);
  runSQL(`DELETE FROM patient_responsibles WHERE patient_id = '${patientId}'`);
  runSQL(`DELETE FROM job_postings WHERE patient_id = '${patientId}'`);
  // Migration 330: o serviço contratado aponta para o endereço (FK sem ON DELETE) — sai ANTES
  // do endereço, ou o DELETE de patient_addresses é recusado. Mesma ordem do purge real.
  runSQL(`DELETE FROM patient_contracted_services WHERE patient_id = '${patientId}'`);
  runSQL(`DELETE FROM patient_addresses WHERE patient_id = '${patientId}'`);
  runSQL(`DELETE FROM patients WHERE id = '${patientId}'`);
}
