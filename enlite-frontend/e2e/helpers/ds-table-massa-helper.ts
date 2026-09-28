/**
 * ds-table-massa-helper.ts
 *
 * Massa sintética ÚNICA e IDEMPOTENTE do spec `ds-table-nao-regressao` (Fase 9, change
 * cadeia-paciente-vacante-itinerario, P3 — DX-9.7). Cobre as 28 telas "com massa" do
 * inventário (`CH/evidencias/fase-9/consumidores-table.tsv`); t01/t02 (Ana Care) ficam
 * VAZIO por design — semear `anacare_*` à mão imitaria o sync (memória
 * `chave-anacare-do-env-esta-defasada`).
 *
 * IDEMPOTÊNCIA: marcador `patients.case_number = 909009`. `ensureDsTableMassa` confere o
 * marcador primeiro — se existe, SÓ RELÊ os ids (nenhum INSERT); se não existe, semeia uma
 * vez. As 3 rodadas do P6/P9 (A1/A2/D, com `DS_TABLE_MASSA_KEEP=1`) leem a MESMA massa.
 *
 * Reusa sem copiar corpo: `insertTestPatient`/`insertTestWorker`/`cleanupTestWorker`
 * (db-test-helper.ts), `insertBaseVacancy` (db-test-helper.ts), `insertWJA`/
 * `cleanupWJAAndEncuadre` (wja-test-helper.ts), `postContractedServiceViaApi`/`backendUrl`
 * (lancamento-e2e-helper.ts), `seedMockStaff`/`cleanupMockStaff` (vacancy-notes-e2e-helper.ts),
 * `runSQL` (patient-detail-a-helper.ts), `tokenFor`/`mockAdminUserFor`
 * (abac-stack-helper.ts/lancamento-e2e-helper.ts). `INSERT` novo só para o que nenhum helper
 * semeia: profissional/responsável/contato externo/projeto terapêutico do paciente, nota da
 * vaga, publicação (Talentum), colisão de telefone (dedup fila), `name_trgm_bidx` compartilhado
 * (dedup importados), auditoria de merge (dedup histórico), tentativa bloqueada, tag, feature
 * de país e mudança de permissão (auditoria de acesso) — cada um por tabela, listado no
 * `P3.md`. P3.1 (achado 2) somou o **grupo de acesso** (`iam.permission_groups` +
 * `group_permissions` + `user_groups`, célula `permission_management:read`, constante
 * `ACCESS_GROUP_NAME`) para t28/t29/t30 (`AccessGate` fail-closed sempre). P3.2 soma o
 * **escopo de país** do MESMO grupo (`iam.group_country_scopes`, país `AR`) — sem ele
 * `resolveCountryScope.ts:135-136` devolve 403 `COUNTRY_SCOPE_REQUIRED` em toda rota
 * `/analytics/dashboard/*` (t26), já que essa rota NUNCA é gated pelo `enforcement` genérico
 * (roda sempre, para todo staff — rule do próprio `resolveCountryScope`).
 *
 * Dados 100% SINTÉTICOS, prefixo `DS Tabla` (rule 6): nenhum nome/telefone/e-mail usa
 * `Date.now()`/`new Date()` — toda identidade é FIXA e literal, o que também é o que permite a
 * releitura idempotente por nome/e-mail/telefone em vez de por id salvo. Datas visíveis (o
 * status transition) recuadas ≥ 3 dias via SQL (`now() - interval`), nunca por conta no runner
 * (rule 8). URL só por `backendUrl()`, lida DENTRO da função; nenhum host/porta literal;
 * nenhum `throw` no import (nada roda fora de função aqui).
 */
import type { APIRequestContext } from '@playwright/test';
import { insertTestPatient, insertTestWorker, insertBaseVacancy, cleanupTestWorker } from './db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from './wja-test-helper';
import { postContractedServiceViaApi, backendUrl } from './lancamento-e2e-helper';
import { seedMockStaff, cleanupMockStaff } from './vacancy-notes-e2e-helper';
import { runSQL } from './patient-detail-a-helper';
import { tokenFor, ABAC_TENANT, type MockUser } from './abac-stack-helper';

// ── Marcador e identidade fixa (rule 6/8: sintético, sem Date.now/new Date) ─────────────────
const CASE_MARKER = 909009;
const CASE_MARKER_PENDING_REVIEW = 909010;

/** P3.1 (achado 2 do P5) — grupo sintético que dá `permission_management:read` ao staff fixo,
 * para t28/t29/t30 (AccessGate fail-closed sempre — useCellAccess direto, sem bypass de
 * enforcement). */
const ACCESS_GROUP_NAME = 'DS Tabla — acceso F9';

export const DS_TABLE_STAFF: MockUser = {
  uid: 'e2e-int-admin-ds-table-f9',
  email: 'admin.ds-table.f9@e2e.test',
  role: 'admin',
  country: 'AR',
};

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

export interface DsTableMassa {
  staff: MockUser;
  patientId: string;
  addressId: string;
  serviceId: string;
  vacancyId: string;
  vacancyPendingReviewId: string;
  workerFunnelId: string;
  workerMatchId: string;
  workerIncompleteId: string;
  dedupWorkerAId: string;
  dedupWorkerBId: string;
  dedupPhoneNormalized: string;
  importedRealWorkerId: string;
  importedGhostWorkerId: string;
  mergeSurvivorId: string;
  mergeAbsorbedId: string;
  tagId: string;
  accessGroupId: string;
}

// ── Releitura (marcador já existe — nenhum INSERT) ──────────────────────────────────────────

function findWorkerByName(firstName: string, lastName: string): string {
  const out = runSQL(
    `SELECT id FROM workers WHERE first_name_encrypted = '${b64(firstName)}' AND last_name_encrypted = '${b64(lastName)}' AND merged_into_id IS NULL ORDER BY created_at LIMIT 1`,
  );
  if (!out) throw new Error(`ds-table-massa: worker "${firstName} ${lastName}" não encontrado na releitura`);
  return out;
}

/** Absorvido pode ter `merged_into_id` setado — não filtra por isso. */
function findWorkerByNameAny(firstName: string, lastName: string): string {
  const out = runSQL(
    `SELECT id FROM workers WHERE first_name_encrypted = '${b64(firstName)}' AND last_name_encrypted = '${b64(lastName)}' ORDER BY created_at LIMIT 1`,
  );
  if (!out) throw new Error(`ds-table-massa: worker "${firstName} ${lastName}" não encontrado na releitura`);
  return out;
}

/** Gate parcial #6: `runSQL` devolve `''` quando a linha não existe — sem esta checagem o campo
 * seguiria como string vazia e o teste falharia LONGE da causa (ex.: navegação para uma rota com
 * id vazio). Mensagem nomeia a coluna/tabela para achar a causa direto. */
function mustField(value: string, label: string): string {
  if (!value) throw new Error(`ds-table-massa: "${label}" vazio na releitura — massa parcial (seed anterior deve ter falhado no meio)`);
  return value;
}

function rereadMassa(patientId: string): DsTableMassa {
  const addressId = mustField(
    runSQL(`SELECT id FROM patient_addresses WHERE patient_id = '${patientId}' ORDER BY created_at LIMIT 1`),
    'addressId (patient_addresses)',
  );
  const serviceId = mustField(
    runSQL(`SELECT id FROM patient_contracted_services WHERE patient_id = '${patientId}' ORDER BY created_at LIMIT 1`),
    'serviceId (patient_contracted_services)',
  );
  const vacancyId = mustField(
    runSQL(`SELECT id FROM job_postings WHERE patient_id = '${patientId}' AND case_number = ${CASE_MARKER} LIMIT 1`),
    'vacancyId (job_postings)',
  );
  const vacancyPendingReviewId = mustField(
    runSQL(`SELECT id FROM job_postings WHERE patient_id = '${patientId}' AND case_number = ${CASE_MARKER_PENDING_REVIEW} LIMIT 1`),
    'vacancyPendingReviewId (job_postings)',
  );
  const workerFunnelId = findWorkerByName('DS Tabla', 'WorkerFunnel');
  const workerMatchId = findWorkerByName('DS Tabla', 'WorkerMatch');
  const workerIncompleteId = findWorkerByName('DS Tabla', 'WorkerIncompleto');
  const dedupWorkerAId = findWorkerByName('DS Tabla', 'WorkerDedupA');
  const dedupWorkerBId = findWorkerByName('DS Tabla', 'WorkerDedupB');
  const importedRealWorkerId = findWorkerByName('DS Tabla', 'WorkerImportadoReal');
  const importedGhostWorkerId = findWorkerByName('DS Tabla', 'WorkerImportadoGhost');
  const mergeSurvivorId = findWorkerByNameAny('DS Tabla', 'WorkerMergeSurvivor');
  const mergeAbsorbedId = findWorkerByNameAny('DS Tabla', 'WorkerMergeAbsorbed');
  const dedupPhoneNormalized = mustField(
    runSQL(`SELECT phone_normalized FROM workers WHERE id = '${dedupWorkerAId}'`),
    'dedupPhoneNormalized (workers.phone_normalized)',
  );
  const tagId = mustField(runSQL(`SELECT id FROM worker_tag_catalog WHERE name = 'DS Tabla' LIMIT 1`), 'tagId (worker_tag_catalog)');
  const accessGroupId = mustField(
    runSQL(`SELECT id FROM iam.permission_groups WHERE tenant_id = '${ABAC_TENANT}' AND name = '${ACCESS_GROUP_NAME}'`),
    'accessGroupId (iam.permission_groups)',
  );

  return {
    staff: DS_TABLE_STAFF,
    patientId,
    addressId,
    serviceId,
    vacancyId,
    vacancyPendingReviewId,
    workerFunnelId,
    workerMatchId,
    workerIncompleteId,
    dedupWorkerAId,
    dedupWorkerBId,
    dedupPhoneNormalized,
    importedRealWorkerId,
    importedGhostWorkerId,
    mergeSurvivorId,
    mergeAbsorbedId,
    tagId,
    accessGroupId,
  };
}

// ── Semeadura (marcador ainda não existe — roda uma única vez) ─────────────────────────────

async function seedMassa(request: APIRequestContext): Promise<DsTableMassa> {
  seedMockStaff(DS_TABLE_STAFF, 'DS Tabla Staff');

  // Paciente: ADMISSION → ACTIVE (1 transição real, t15) + endereço fixo + serviço AT (t14).
  const { patientId, addressId } = insertTestPatient({
    status: 'ADMISSION',
    firstName: 'DS Tabla',
    lastName: 'Paciente F9',
    diagnosis: 'DS Tabla — diagnóstico sintético e2e',
    dependencyLevel: 'MODERATE',
    withAddress: true,
    addressLat: -34.6037,
    addressLng: -58.3816,
    hasConsent: true,
    insuranceInformed: 'OSDE',
  });
  if (!addressId) throw new Error('ds-table-massa: paciente sem addressId');
  // Gate parcial #6: o marcador (`case_number`) só é gravado no FIM desta função (ver `return`
  // abaixo) — gravá-lo aqui, cedo, faria uma `ensureDsTableMassa` concorrente/seguinte encontrar
  // o marcador e cair em `rereadMassa` sobre uma massa PARCIAL (seed morreu no meio), lendo ids
  // vazios de tabelas ainda não semeadas.
  // Trigger `fn_log_patient_status_change` grava a transição — `updated_at`/`created_at` da
  // linha de histórico saem do NOW() do Postgres; sem conta de data no runner (rule 8).
  runSQL(`UPDATE patients SET status = 'ACTIVE', updated_at = now() - interval '3 days' WHERE id = '${patientId}'`);

  const token = tokenFor(DS_TABLE_STAFF);
  const serviceId = await postContractedServiceViaApi(request, token, patientId, {
    serviceCode: 'AT',
    providersNeeded: 1,
    weeklyHours: 20,
    careLocation: 'HOME',
    addressId,
    schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
  });

  // Profissional / responsável / contato externo (t12/t13) — nenhum helper existente semeia.
  runSQL(
    `INSERT INTO patient_professionals (patient_id, name, phone_encrypted, email_encrypted, display_order, is_team) VALUES ('${patientId}', 'DS Tabla Dra. Profesional', '${b64('+5491100000905')}', NULL, 1, false)`,
  );
  runSQL(
    `INSERT INTO patient_responsibles (patient_id, first_name, last_name, relationship, phone_encrypted, email_encrypted, document_number_encrypted, document_type, is_primary, display_order, source) VALUES ('${patientId}', 'DS Tabla', 'Responsable F9', 'PARENT', '${b64('+5491100000906')}', NULL, '${b64('90000906')}', 'DNI', true, 1, 'web_form')`,
  );
  runSQL(
    `INSERT INTO patient_external_contacts (patient_id, relation, name, phone_encrypted, sort_order, created_by) VALUES ('${patientId}', 'NEIGHBOR', 'DS Tabla Contacto Externo', '${b64('+5491100000907')}', 1, '${DS_TABLE_STAFF.uid}')`,
  );

  // Projeto terapêutico versão 1.0 (t12) — imutável, satélite do serviço contratado acima.
  runSQL(
    `INSERT INTO patient_therapeutic_projects (patient_id, major, minor, contracted_service_id, diagnoses, clinical_context, general_objective, specific_objectives, activities, pathology_types, start_date, end_date, created_by) VALUES (` +
      `'${patientId}', 1, 0, '${serviceId}', ` +
      `'[{"uri":"synthetic:ds-tabla","code":"DS-TABLA","title":"DS Tabla diagnóstico sintético"}]'::jsonb, ` +
      `'DS Tabla — contexto clínico sintético e2e (Fase 9), sem dado real.', ` +
      `'DS Tabla — objetivo geral sintético e2e (Fase 9).', ` +
      `'[{"id":"ds-tabla-1","label":"DS Tabla objetivo específico"}]'::jsonb, ` +
      `'[{"id":"ds-tabla-1","label":"DS Tabla actividad"}]'::jsonb, ` +
      `'[{"id":"ds-tabla-1","label":"DS Tabla patología"}]'::jsonb, ` +
      `CURRENT_DATE - interval '10 days', CURRENT_DATE + interval '90 days', '${DS_TABLE_STAFF.uid}')`,
  );

  // Vaga publicada (t05/06/07/08/10/11/26) + publicação Talentum (t07) + nota (t08).
  const vacancyId = insertBaseVacancy({
    patientId,
    patientAddressId: addressId,
    caseNumber: CASE_MARKER,
    status: 'SEARCHING',
    isDraft: false,
    requiredProfessions: ['AT'],
  });
  runSQL(
    `INSERT INTO publications (job_posting_id, channel, group_name, recruiter_name, published_at, dedup_hash) VALUES ('${vacancyId}', 'whatsapp', 'DS Tabla Grupo', 'DS Tabla Recruiter', now() - interval '3 days', md5('${vacancyId}-ds-tabla-f9'))`,
  );
  runSQL(
    `INSERT INTO job_posting_notes (job_posting_id, occurred_at, category, contact, body, created_by) VALUES ('${vacancyId}', now() - interval '3 days', 'CONTATO', 'DS Tabla Contacto', 'DS Tabla — nota sintética e2e (Fase 9), sem dado real.', '${DS_TABLE_STAFF.uid}')`,
  );

  // 2ª vaga do MESMO paciente, sem patient_address_id → "direcciones pendientes" (t18).
  const vacancyPendingReviewId = insertBaseVacancy({
    patientId,
    patientAddressId: addressId,
    caseNumber: CASE_MARKER_PENDING_REVIEW,
    status: 'PENDING_ACTIVATION',
    isDraft: false,
    requiredProfessions: ['AT'],
  });
  runSQL(`UPDATE job_postings SET patient_address_id = NULL WHERE id = '${vacancyPendingReviewId}'`);

  // Worker do funil (t05, aba encuadres — o trigger `trg_ensure_encuadre_on_wja_insert` cria o
  // encuadre sozinho, que é o que t04/WorkerEncuadresCard precisa) + convite "real" (messaged_at).
  const workerFunnelId = insertTestWorker({
    firstName: 'DS Tabla',
    lastName: 'WorkerFunnel',
    phone: '+5491100000901',
    occupation: 'AT',
    lat: -34.6037,
    lng: -58.3816,
  });
  const wjaId = insertWJA({ workerId: workerFunnelId, jobPostingId: vacancyId, funnelStage: 'INVITED', source: 'system' });
  runSQL(`UPDATE worker_job_applications SET messaged_at = now() - interval '3 days' WHERE id = '${wjaId}'`);

  // Worker no raio, SEM WJA — candidato do modal de match (t06).
  const workerMatchId = insertTestWorker({
    firstName: 'DS Tabla',
    lastName: 'WorkerMatch',
    phone: '+5491100000902',
    occupation: 'AT',
    lat: -34.6037 + 0.0009,
    lng: -58.3816,
  });

  // Worker incompleto → tentativa bloqueada (t17). Sem FK (migration 209) — id sem exigir
  // worker "válido" para o gate, mas usar um worker real deixa a trilha honesta.
  const workerIncompleteId = insertTestWorker({
    firstName: 'DS Tabla',
    lastName: 'WorkerIncompleto',
    phone: '+5491100000903',
    status: 'INCOMPLETE_REGISTER',
  });
  runSQL(
    `INSERT INTO worker_blocked_applications (worker_id, job_posting_id, blocked_reason_at_attempt, missing_fields_at_attempt, attempt_count, acquisition_channel, first_attempted_at, last_attempted_at) VALUES ('${workerIncompleteId}', '${vacancyId}', 'registration_incomplete', '["phone","worker_documents"]'::jsonb, 1, 'site', now() - interval '3 days', now() - interval '3 days')`,
  );

  // Par de telefone colidindo (t19 — dedup fila): mesmos 10/12 dígitos → mesmo phone_normalized
  // (molde `admin-dedup-center.e2e.test.ts`), sem entrar em `dedup_dismissed`.
  const dedupWorkerAId = insertTestWorker({ firstName: 'DS Tabla', lastName: 'WorkerDedupA', phone: '1100000904' });
  const dedupWorkerBId = insertTestWorker({ firstName: 'DS Tabla', lastName: 'WorkerDedupB', phone: '541100000904' });
  const dedupPhoneNormalized = runSQL(`SELECT phone_normalized FROM workers WHERE id = '${dedupWorkerAId}'`);
  runSQL(
    `INSERT INTO worker_phone_collisions (phone_normalized, worker_ids, worker_count) VALUES ('${dedupPhoneNormalized}', ARRAY['${dedupWorkerAId}','${dedupWorkerBId}']::uuid[], 2) ON CONFLICT (phone_normalized) DO NOTHING`,
  );

  // Par por NOME (t20 — dedup importados): mesmo `name_trgm_bidx`, 1 conta real + 1 "@enlite.import"
  // (molde `admin-dedup-imported-groups.e2e.test.ts` — bidx injetado direto, sem depender de KMS real).
  const importedRealWorkerId = insertTestWorker({
    firstName: 'DS Tabla',
    lastName: 'WorkerImportadoReal',
    phone: '+5491100000908',
  });
  runSQL(`UPDATE workers SET email = 'ds.tabla.f9.real@e2e.test' WHERE id = '${importedRealWorkerId}'`);
  const importedGhostWorkerId = insertTestWorker({
    firstName: 'DS Tabla',
    lastName: 'WorkerImportadoGhost',
    phone: '+5491100000909',
  });
  runSQL(`UPDATE workers SET email = 'ds.tabla.f9.ghost@enlite.import' WHERE id = '${importedGhostWorkerId}'`);
  runSQL(
    `UPDATE workers SET name_trgm_bidx = ARRAY['\\x${Buffer.from('ds-tabla-f9-imported-bidx', 'utf8').toString('hex')}'::bytea] WHERE id IN ('${importedRealWorkerId}','${importedGhostWorkerId}')`,
  );

  // Par mergeado (t21 — dedup histórico): auditoria direta, sem passar pelo endpoint (o merge de
  // verdade já é testado nos e2e do backend; aqui só precisamos da LINHA de histórico).
  const mergeSurvivorId = insertTestWorker({ firstName: 'DS Tabla', lastName: 'WorkerMergeSurvivor', phone: '+5491100000910' });
  const mergeAbsorbedId = insertTestWorker({ firstName: 'DS Tabla', lastName: 'WorkerMergeAbsorbed', phone: '+5491100000911' });
  runSQL(`UPDATE workers SET merged_into_id = '${mergeSurvivorId}' WHERE id = '${mergeAbsorbedId}'`);
  runSQL(
    `INSERT INTO worker_merge_audit (survivor_id, absorbed_id, phone_normalized, category, fields_filled, exceptions, executed_by, executed_by_email, source, confirmed_same_person, created_at) VALUES ('${mergeSurvivorId}', '${mergeAbsorbedId}', '5491100000911', 'most_complete', '[]'::jsonb, '[]'::jsonb, '${DS_TABLE_STAFF.uid}', '${DS_TABLE_STAFF.email}', 'manual', true, now() - interval '3 days')`,
  );

  // Tag (t23) — catálogo, sem atribuir a nenhum worker (a tela lista o catálogo). `-tAc` do
  // `runSQL` não suprime o rótulo de comando ("INSERT 0 1") numa linha depois do id retornado
  // por `RETURNING` — pega só a 1ª linha (mesmo padrão de `scalar()` em `abac-stack-helper.ts`).
  const tagId = runSQL(
    `INSERT INTO worker_tag_catalog (name, color, description, created_by) VALUES ('DS Tabla', '#180149', 'Tag sintética e2e — Fase 9', '${DS_TABLE_STAFF.uid}') RETURNING id`,
  )
    .split('\n')[0]
    .trim();

  // Feature de país (t29 — `iam.country_features`, chave no formato `screen:<slug>` exigido por
  // `isValidFeatureKey`).
  runSQL(
    `INSERT INTO iam.country_features (country, feature_key, enabled, source, updated_by) VALUES ('AR', 'screen:ds-table-massa-f9', true, 'override', '${DS_TABLE_STAFF.uid}')`,
  );

  // Auditoria de acesso (t30 — `PermissionHistoryPage` lê `iam.permission_group_changes` +
  // `iam.user_groups`, NÃO `iam.permission_audit_log` como o mapa da DX-9.6 previa — medido no
  // código, `PermissionHistory.ts:7`; DESVIO reportado no retorno do P3). Reusa grupo/permissão
  // já existentes na seed do 274/206 — não cria nenhum dos dois.
  const anyGroupId = runSQL(`SELECT id FROM iam.permission_groups ORDER BY name LIMIT 1`);
  const anyPermissionId = runSQL(`SELECT id FROM iam.permissions ORDER BY resource, action LIMIT 1`);
  runSQL(
    `INSERT INTO iam.permission_group_changes (group_id, permission_id, op, changed_by, changed_at, reason) VALUES ('${anyGroupId}', '${anyPermissionId}', 'add', '${DS_TABLE_STAFF.uid}', now() - interval '3 days', 'DS Tabla — e2e Fase 9 (ds-table-nao-regressao)')`,
  );

  // Grupo de acesso (t28/t29/t30 — P3.1, achado 2 do P5): dá `permission_management:read` ao
  // staff fixo, sem o qual `AccessGate` (fail-closed sempre) redireciona /admin/access* para /admin.
  let accessGroupId = runSQL(
    `INSERT INTO iam.permission_groups (tenant_id, name, description, created_by)
     VALUES ('${ABAC_TENANT}', '${ACCESS_GROUP_NAME}', 'grupo sintetico e2e Fase 9 (ds-table-nao-regressao)', '${DS_TABLE_STAFF.uid}')
     ON CONFLICT (tenant_id, name) DO NOTHING RETURNING id`,
  )
    .split('\n')[0]
    .trim();
  if (!accessGroupId) {
    accessGroupId = runSQL(
      `SELECT id FROM iam.permission_groups WHERE tenant_id='${ABAC_TENANT}' AND name='${ACCESS_GROUP_NAME}'`,
    )
      .split('\n')[0]
      .trim();
  }
  runSQL(
    `INSERT INTO iam.group_permissions (group_id, permission_id)
     SELECT '${accessGroupId}', id FROM iam.permissions WHERE resource='permission_management' AND action='read'
     ON CONFLICT (group_id, permission_id) DO NOTHING`,
  );
  runSQL(
    `INSERT INTO iam.user_groups (user_id, group_id, tenant_id)
     VALUES ('${DS_TABLE_STAFF.uid}', '${accessGroupId}', '${ABAC_TENANT}')
     ON CONFLICT (user_id, group_id) WHERE removed_at IS NULL DO NOTHING`,
  );

  // Gate parcial #6: marcador gravado por ÚLTIMO — só depois que TODA a massa acima existe.
  // `ensureDsTableMassa` só decide "já existe, só relê" a partir deste UPDATE.
  runSQL(`UPDATE patients SET case_number = ${CASE_MARKER} WHERE id = '${patientId}'`);

  return {
    staff: DS_TABLE_STAFF,
    patientId,
    addressId,
    serviceId,
    vacancyId,
    vacancyPendingReviewId,
    workerFunnelId,
    workerMatchId,
    workerIncompleteId,
    dedupWorkerAId,
    dedupWorkerBId,
    dedupPhoneNormalized,
    importedRealWorkerId,
    importedGhostWorkerId,
    mergeSurvivorId,
    mergeAbsorbedId,
    tagId,
    accessGroupId,
  };
}

// ── API pública ──────────────────────────────────────────────────────────────────────────────

/**
 * Idempotente: confere `patients.case_number = 909009` primeiro. Se existe, SÓ relê (nenhum
 * INSERT); senão semeia uma vez. Ler `request` dentro da função (Playwright só chama isto de
 * dentro de um teste/hook, nunca no import).
 */
export async function ensureDsTableMassa(request: APIRequestContext): Promise<DsTableMassa> {
  void backendUrl(); // força a leitura dentro da função (nunca em const de módulo) — sem uso direto aqui, o insert via API já lê a env.
  const existingPatientId = runSQL(`SELECT id FROM patients WHERE case_number = ${CASE_MARKER} LIMIT 1`);
  const massa = existingPatientId ? rereadMassa(existingPatientId) : await seedMassa(request);
  // P3.2 (achado 1 do P3.1/P5): escopo de país (AR) do grupo do staff fixo, sem o qual
  // `resolveCountryScope.ts:135-136` devolve 403 `COUNTRY_SCOPE_REQUIRED` em toda rota
  // `/analytics/dashboard/*` (t26). Roda em TODA chamada (seed ou releitura) — `ON CONFLICT`
  // idempotente contra o índice parcial `uq_group_country_scopes_live` (group_id, country) WHERE
  // revoked_at IS NULL — nunca duplica.
  runSQL(
    `INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
     VALUES ('${massa.accessGroupId}', 'AR', '${DS_TABLE_STAFF.uid}', 'DS Tabla — e2e Fase 9 (ds-table-nao-regressao, P3.2)')
     ON CONFLICT (group_id, country) WHERE revoked_at IS NULL DO NOTHING`,
  );
  return massa;
}

/**
 * Ordem de FK: merge/colisão → bloqueio → nota/publicação → WJA/encuadre → job_postings →
 * profissional/responsável → paciente (1 `DELETE FROM patients`) → workers (absorvido ANTES do
 * sobrevivente — `workers_merged_into_id_fkey`) → tag → feature de país → mudança de permissão →
 * staff.
 *
 * NÃO reusa `cleanupPatientDeep` (patient-detail-a-helper.ts) aqui: a ordem fixa dela apaga
 * `patient_contracted_services` ANTES de `patients`, e a versão do projeto terapêutico (P3, tabela
 * nova desta massa) tem FK `NOT NULL` para o serviço contratado — apagar o serviço primeiro
 * violaria essa FK. `patient_therapeutic_projects` também tem trigger de imutabilidade que
 * RECUSA `DELETE` explícito enquanto o paciente ainda existe (lex C5) — só aceita sumir via
 * `ON DELETE CASCADE` no MESMO `DELETE FROM patients`. Por isso aqui NADA satélite do paciente é
 * apagado explicitamente: profissional/responsável (sem CASCADE — explícitos) e endereço/serviço/
 * projeto terapêutico/contato externo (CASCADE — só o `DELETE FROM patients` final).
 */
export function cleanupDsTableMassa(m: DsTableMassa): void {
  runSQL(`DELETE FROM worker_merge_snapshots WHERE merge_audit_id IN (SELECT id FROM worker_merge_audit WHERE survivor_id = '${m.mergeSurvivorId}')`);
  runSQL(`DELETE FROM worker_merge_audit WHERE survivor_id = '${m.mergeSurvivorId}'`);
  runSQL(`DELETE FROM worker_phone_collisions WHERE phone_normalized = '${m.dedupPhoneNormalized}'`);
  runSQL(`DELETE FROM dedup_dismissed WHERE phone_normalized = '${m.dedupPhoneNormalized}'`);
  runSQL(`DELETE FROM worker_blocked_applications WHERE worker_id = '${m.workerIncompleteId}'`);
  runSQL(`DELETE FROM job_posting_notes WHERE job_posting_id IN ('${m.vacancyId}','${m.vacancyPendingReviewId}')`);
  runSQL(`DELETE FROM publications WHERE job_posting_id = '${m.vacancyId}'`);
  cleanupWJAAndEncuadre(m.workerFunnelId, m.vacancyId);
  runSQL(`DELETE FROM job_postings WHERE id IN ('${m.vacancyId}','${m.vacancyPendingReviewId}')`);
  runSQL(`DELETE FROM patient_professionals WHERE patient_id = '${m.patientId}'`);
  runSQL(`DELETE FROM patient_responsibles WHERE patient_id = '${m.patientId}'`);
  // CASCADE cuida de patient_addresses, patient_contracted_services, patient_therapeutic_projects
  // e patient_external_contacts — nenhuma dessas 4 é apagada explicitamente antes desta linha.
  runSQL(`DELETE FROM patients WHERE id = '${m.patientId}'`);
  // Absorvido antes do sobrevivente: `workers.merged_into_id` referencia o sobrevivente.
  for (const workerId of [
    m.workerFunnelId,
    m.workerMatchId,
    m.workerIncompleteId,
    m.dedupWorkerAId,
    m.dedupWorkerBId,
    m.importedRealWorkerId,
    m.importedGhostWorkerId,
    m.mergeAbsorbedId,
    m.mergeSurvivorId,
  ]) {
    try {
      cleanupTestWorker(workerId);
    } catch (err) {
      console.error('[cleanup] worker falhou (seguindo)', err);
    }
  }
  runSQL(`DELETE FROM worker_tag_catalog WHERE id = '${m.tagId}'`);
  runSQL(`DELETE FROM iam.country_features WHERE country = 'AR' AND feature_key = 'screen:ds-table-massa-f9'`);
  runSQL(`DELETE FROM iam.permission_group_changes WHERE reason = 'DS Tabla — e2e Fase 9 (ds-table-nao-regressao)'`);
  try {
    // P3.2: escopo de país cai por CASCADE ao apagar o grupo (FK `group_country_scopes_group_id_fkey
    // ... ON DELETE CASCADE`), mas o DELETE explícito segue a MESMA convenção dos irmãos (ordem
    // FK-safe explícita, nunca depender do cascade silenciosamente).
    runSQL(`DELETE FROM iam.group_country_scopes WHERE group_id = '${m.accessGroupId}'`);
    runSQL(`DELETE FROM iam.user_groups WHERE user_id = '${m.staff.uid}' AND group_id = '${m.accessGroupId}'`);
    runSQL(`DELETE FROM iam.group_permissions WHERE group_id = '${m.accessGroupId}'`);
    runSQL(`DELETE FROM iam.permission_groups WHERE id = '${m.accessGroupId}'`);
  } catch (err) {
    console.error('[cleanup] grupo de acesso (P3.1) falhou (seguindo)', err);
  }
  cleanupMockStaff(m.staff);
}
