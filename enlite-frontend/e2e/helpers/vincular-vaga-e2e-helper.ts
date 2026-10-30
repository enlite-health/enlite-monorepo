/**
 * vincular-vaga-e2e-helper.ts — seed/leitura/limpeza por SQL (docker `enlite-postgres`) do e2e de TELA da spec 079
 * (vincular vaga existente ao serviço contratado), spec §8.3: feliz + 2 alternativos (endereço diferente; serviço sem
 * faixa vigente). Só IMPORTA os helpers existentes (`patient-detail-c-helper`, `patient-detail-a-helper`,
 * `patient-addresses-test-helper`, `recruitment-fields-e2e`). Dados 100% SINTÉTICOS (sobrenome " QA"), sem clínico, sem
 * canal real: o seed não passa pela API, então nada de WhatsApp/Talentum/Calendar é tocado.
 *
 * Cuidado de shell: `runSQL` embrulha o SQL em aspas duplas — nada de `"`, `$` ou crase nos comandos daqui.
 */
import { insertSecondAddress } from './patient-addresses-test-helper';
import { RECRUITMENT_FIELDS_E2E } from './recruitment-fields-e2e';
import {
  runSQL, cleanupPatientDeep, cleanupWorker, seedActivatablePatient, seedWorker,
} from './patient-detail-c-helper';

export { seedActivatablePatient, runSQL };

const stampUnico = (): string => `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const sqlTexto = (v: string | null | undefined): string => (v == null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);
const sqlNum = (v: number | null | undefined): string => (v == null ? 'NULL' : String(Number(v)));

/** Campos de dono-serviço da vaga legada (spec §4). `null` = coluna NULL; omitido = valor sintético de RECRUITMENT_FIELDS_E2E. */
export interface LegacyVacancyFields {
  required_sex: string | null;
  work_schedule: string | null;
  payment_day: string | null;
  required_experience: string | null;
  required_professions: string[] | null;
  /** TEXT na vaga (INT no serviço): passe 'dois' para provar "não inteiro não alimenta". */
  providers_needed: string | null;
  age_range_min: number | null;
  age_range_max: number | null;
}

export interface LegacyVacancySeed {
  vacancyId: string;
  caseNumber: number;
  caseOrdinal: number;
  applicationId: string;
  encuadreId: string;
  workerId: string;
}

/**
 * Vaga LEGADA do paciente: `contracted_service_id` NULL, `status` SEARCHING, `deleted_at` NULL, publicada
 * (`is_draft=false`), 1 candidatura (worker sintético de `seedWorker`) e 1 encuadre ligado à vaga (o Kanban que o vínculo
 * não pode mexer). `addressId` null = vaga sem endereço. Colunas: 011 (job_postings/worker_job_applications), 014
 * (encuadres), 107 (campos de vaga), 149 (patient_address_id), 460 (case_ordinal).
 */
export function seedLegacyVacancy(
  patientId: string,
  opts: { addressId: string | null; fields?: Partial<LegacyVacancyFields> },
): LegacyVacancySeed {
  const f: LegacyVacancyFields = {
    required_sex: RECRUITMENT_FIELDS_E2E.requiredSex,
    work_schedule: RECRUITMENT_FIELDS_E2E.workSchedule,
    payment_day: RECRUITMENT_FIELDS_E2E.paymentDay,
    required_experience: RECRUITMENT_FIELDS_E2E.requiredExperience,
    required_professions: [...RECRUITMENT_FIELDS_E2E.requiredProfessions],
    providers_needed: '1',
    age_range_min: null,
    age_range_max: null,
    ...opts.fields,
  };
  const caseNumber = Number(runSQL(`SELECT case_number FROM patients WHERE id = '${patientId}'`));
  if (!Number.isFinite(caseNumber) || caseNumber <= 0) throw new Error('seedLegacyVacancy: paciente sem case_number');
  const professions = f.required_professions === null
    ? 'NULL'
    : `ARRAY[${f.required_professions.map((p) => sqlTexto(p)).join(',')}]::text[]`;
  // `CTE por fora` como em seedWorker: o comando visível é um SELECT, então runSQL devolve só o valor.
  const row = runSQL(
    `WITH ins AS (INSERT INTO job_postings (vacancy_number, case_number, case_ordinal, title, description, patient_id, patient_address_id, ` +
    `required_professions, required_sex, required_experience, work_schedule, payment_day, providers_needed, age_range_min, age_range_max, ` +
    `status, is_draft, country, created_at, updated_at) VALUES (nextval('job_postings_vacancy_number_seq'), ${caseNumber}, ` +
    `(SELECT COALESCE(MAX(case_ordinal), 0) + 1 FROM job_postings WHERE patient_id = '${patientId}'), ` +
    `'CASO ${caseNumber} vaga legada QA', 'vaga legada sintetica e2e', '${patientId}', ${opts.addressId ? `'${opts.addressId}'` : 'NULL'}, ` +
    `${professions}, ${sqlTexto(f.required_sex)}, ${sqlTexto(f.required_experience)}, ${sqlTexto(f.work_schedule)}, ${sqlTexto(f.payment_day)}, ` +
    `${sqlTexto(f.providers_needed)}, ${sqlNum(f.age_range_min)}, ${sqlNum(f.age_range_max)}, 'SEARCHING', false, 'AR', NOW(), NOW()) ` +
    `RETURNING id, case_ordinal) SELECT id || '|' || case_ordinal FROM ins`,
  );
  const [vacancyId, ordinal] = row.split('|');
  if (!vacancyId) throw new Error(`seedLegacyVacancy: INSERT sem id (saída: ${row})`);

  const { workerId } = seedWorker(stampUnico());
  // application_funnel_stage / source: mesmos valores de enquadres-076-seed.ts.
  const applicationId = runSQL(
    `WITH ins AS (INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) ` +
    `VALUES ('${workerId}', '${vacancyId}', 'COMPLETED', 'talentum') RETURNING id) SELECT id FROM ins`,
  );
  // Inserir a candidatura JÁ cria o encuadre (trigger: `encuadres_worker_job_unique` barra o 2º INSERT — medido na 1ª execução
  // contra banco). Então o encuadre é LIDO, e só semeado à mão se o trigger não o tiver criado.
  const lerEncuadre = (): string => runSQL(`SELECT id FROM encuadres WHERE worker_id = '${workerId}' AND job_posting_id = '${vacancyId}'`);
  let encuadreId = lerEncuadre();
  if (!encuadreId) {
    runSQL(
      `WITH ins AS (INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, resultado) ` +
      `VALUES ('${workerId}', '${vacancyId}', 'Prestador Fixture QA', 'PENDIENTE') RETURNING id) SELECT id FROM ins`,
    );
    encuadreId = lerEncuadre();
  }
  if (!encuadreId) throw new Error('seedLegacyVacancy: vaga sem encuadre');
  return { vacancyId, caseNumber, caseOrdinal: Number(ordinal), applicationId, encuadreId, workerId };
}

/**
 * Serviço contratado ATIVO do paciente (service_code AT) vinculado ao endereço `addressId`, SEM vaga e SEM os 5 campos de
 * recrutamento (a vaga legada os alimenta), salvo `requiredExperience` (serviço com um campo próprio). `withSchedule=false` = sem NENHUMA linha em `patient_itinerary_slot` (o
 * alternativo "sem faixa vigente" do portão); `true` = 1 faixa vigente (480 + coluna `valid`/`duration_minutes`,
 * molde `transicao-estado-051`). `seedActivatablePatient` NÃO cria serviço, por isso esta função existe.
 */
export function seedContractedService(
  patientId: string,
  opts: { addressId: string | null; withSchedule: boolean; requiredExperience?: string },
): { serviceId: string } {
  const serviceId = runSQL(
    `WITH ins AS (INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by, address_id) ` +
    `VALUES ('${patientId}', 'AT', true, 'AR', 'e2e079', 'e2e079', ${opts.addressId ? `'${opts.addressId}'` : 'NULL'}) RETURNING id) SELECT id FROM ins`,
  );
  if (!serviceId) throw new Error('seedContractedService: INSERT sem id');
  // Campo JÁ preenchido no serviço com valor diferente do da vaga: é o único que a prévia lista (a vaga entrega o resto igual).
  if (opts.requiredExperience !== undefined) {
    runSQL(`UPDATE patient_contracted_services SET required_experience = ${sqlTexto(opts.requiredExperience)} WHERE id = '${serviceId}'`);
  }
  if (opts.withSchedule) {
    runSQL(
      `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by) ` +
      `VALUES ('${serviceId}', 1, '08:00', 240, '[2026-01-01,)'::daterange, 'e2e079', 'e2e079')`,
    );
  }
  return { serviceId };
}

/** Alternativo 2 do portão: serviço ativo SEM faixa vigente (nenhuma linha em `patient_itinerary_slot`). */
export function seedServiceWithoutSchedule(patientId: string, addressId: string | null): { serviceId: string } {
  return seedContractedService(patientId, { addressId, withSchedule: false });
}

/** Alternativo 1 (endereço diferente): troca o endereço do serviço (`patient_contracted_services.address_id`, 330). */
export function setServiceAddress(serviceId: string, addressId: string | null): void {
  runSQL(`UPDATE patient_contracted_services SET address_id = ${addressId ? `'${addressId}'` : 'NULL'} WHERE id = '${serviceId}'`);
}

/** 2º endereço (B) do MESMO paciente, para a vaga num e o serviço noutro. Devolve o id. */
export function createPatientAddress(patientId: string): string {
  return insertSecondAddress({ patientId, addressFormatted: 'Av. Santa Fe 4321, CABA, AR (QA)' });
}

export interface KanbanFingerprint { id: string; applications: number; encuadres: number; invitations: number }

/**
 * Impressão digital do Kanban da vaga: o id + contagens por FK na vaga. `invitations` =
 * `presentation_invite_log` (293, trilha de cada clique de convite; FK `job_posting_id`). Igual antes e depois do vínculo.
 */
export function readVacancyKanbanFingerprint(vacancyId: string): KanbanFingerprint {
  const out = runSQL(
    `SELECT jp.id || '|' || (SELECT count(*) FROM worker_job_applications WHERE job_posting_id = jp.id) || '|' || ` +
    `(SELECT count(*) FROM encuadres WHERE job_posting_id = jp.id) || '|' || ` +
    `(SELECT count(*) FROM presentation_invite_log WHERE job_posting_id = jp.id) FROM job_postings jp WHERE jp.id = '${vacancyId}'`,
  );
  const [id, applications, encuadres, invitations] = out.split('|');
  if (!id) throw new Error(`readVacancyKanbanFingerprint: vaga ${vacancyId} não existe`);
  return { id, applications: Number(applications), encuadres: Number(encuadres), invitations: Number(invitations) };
}

/** Colunas lidas (texto) — cada leitura vira `chave=valor` por linha; `<NULL>` = NULL. */
const lerColunas = (sql: string, colunas: string[]): Record<string, string | null> => {
  const out = runSQL(sql);
  if (!out) throw new Error('leitura sem linha');
  const partes = out.split('\u001f');
  return Object.fromEntries(colunas.map((c, i) => [c, partes[i] === '<NULL>' ? null : partes[i]]));
};
const juntar = (colunas: string[], prefixo = ''): string =>
  colunas.map((c) => `COALESCE(${prefixo}${c}::text, '<NULL>')`).join(` || chr(31) || `);

const CAMPOS_VAGA = ['contracted_service_id', 'required_professions', 'required_sex', 'required_experience', 'work_schedule', 'payment_day', 'providers_needed', 'age_range_min', 'age_range_max', 'patient_address_id', 'status', 'deleted_at'];
const CAMPOS_SERVICO = ['required_professions', 'required_sex', 'required_experience', 'work_schedule', 'payment_day', 'providers_needed', 'provider_age_band', 'address_id'];

/** Colunas CRUAS da vaga (spec §4) + vínculo: prova "nada gravado" nos alternativos e "vaga esvaziada" no feliz. */
export function readVacancyServiceFields(vacancyId: string): Record<string, string | null> {
  return lerColunas(`SELECT ${juntar(CAMPOS_VAGA)} FROM job_postings WHERE id = '${vacancyId}'`, CAMPOS_VAGA);
}

/** Campos de recrutamento + endereço do serviço (518, 322, 330): prova "serviço alimentado" (feliz) ou intocado (alternativos). */
export function readServiceRecruitmentFields(serviceId: string): Record<string, string | null> {
  return lerColunas(`SELECT ${juntar(CAMPOS_SERVICO)} FROM patient_contracted_services WHERE id = '${serviceId}'`, CAMPOS_SERVICO);
}

export interface VincularVagaCleanup {
  patientId?: string;
  workerIds?: string[];
}

/**
 * Apaga o que o seed criou: `cleanupPatientDeep` remove vagas (candidaturas e encuadres saem em CASCADE), serviços (faixas em
 * CASCADE, e audit_log da vaga em CASCADE), endereços e o paciente; os workers semeados saem à parte (`cleanupWorker`).
 */
export function cleanupVincularVaga(c: VincularVagaCleanup): void {
  if (c.patientId) cleanupPatientDeep(c.patientId);
  for (const w of c.workerIds ?? []) cleanupWorker(w);
}
