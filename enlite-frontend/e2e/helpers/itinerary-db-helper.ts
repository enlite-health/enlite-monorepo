/**
 * itinerary-db-helper.ts — seed direto no Postgres (via `docker exec enlite-postgres psql`, o
 * MESMO padrão de `db-test-helper.ts`) para os e2e de integração da aba Itinerario (D445, rodada
 * 2). Monta um paciente com 1 serviço contratado, 1 vaga viva, N workers "Selecionados"
 * (`QUICK_RESPONSE_TEAM`) e slots — o mínimo para `allocate`/`replace`/eventos passarem pela API
 * REAL sem mock.
 */
import { execSync } from 'child_process';

const CONTAINER = process.env.E2E_PG_CONTAINER || 'enlite-postgres';
const DB_USER = 'enlite_admin';
const DB_NAME = 'enlite_e2e';

function runSQL(sql: string): string {
  const escaped = sql.replace(/'/g, "'\\''");
  try {
    return execSync(`docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -t -A -c '${escaped}'`, { stdio: 'pipe' }).toString();
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message?: string };
    throw new Error(`DB error: ${e.stderr?.toString() ?? e.message}`);
  }
}

function firstLine(out: string): string {
  return out.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
}

export interface ItinerarySeed {
  patientId: string;
  serviceId: string;
  jobId: string;
  slotId: string;
  addressLabel: string;
  titularWorkerId: string;
  substituteWorkerId: string;
  permanentWorkerId: string;
  /** Substituto SEM conflito — o do caminho feliz (o `substituteWorkerId` colide de propósito, alternativo 1). */
  freeSubstituteWorkerId: string;
  /** Nome de tela de cada worker sintético (`<Nome> <Sobrenome>`). */
  names: { titular: string; substitute: string; permanent: string; free: string };
  /** Próxima segunda-feira (weekday=1) — calculada NO BANCO, nunca no runner Node. */
  nextMonday: string;
}

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TASK_PREFIX = `itin-pw-${RUN}-`;

/** Nomes sintéticos (massa de teste) — com KMS desligado no stack local o "cifrado" é base64 puro. */
const enc = (v: string): string => Buffer.from(v, 'utf8').toString('base64');

function mkWorker(label: string, jobId: string, firstName: string, lastName: string, occupation: string): string {
  const authUid = `${TASK_PREFIX}${label}`;
  runSQL(`
    INSERT INTO workers (auth_uid, email, country, first_name_encrypted, last_name_encrypted, occupation)
    VALUES ('${authUid}', '${authUid}@e2e.local', 'AR', '${enc(firstName)}', '${enc(lastName)}', '${occupation}')
  `);
  const workerId = firstLine(runSQL(`SELECT id FROM workers WHERE auth_uid = '${authUid}'`));
  runSQL(`
    INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
    VALUES ('${workerId}', '${jobId}', 'QUICK_RESPONSE_TEAM', 'import')
  `);
  return workerId;
}

/** Semeia um paciente completo para os e2e de tela — 1 serviço, 1 slot (segunda 09:00-11:00), 4 Selecionados. */
export function seedItinerary(): ItinerarySeed {
  const clickupTaskId = `${TASK_PREFIX}p1`;
  runSQL(`
    INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
    VALUES ('${clickupTaskId}', 'Itinerario', 'PlaywrightE2E', 'AR', 'ACTIVE')
  `);
  const patientId = firstLine(runSQL(`SELECT id FROM patients WHERE clickup_task_id = '${clickupTaskId}'`));

  const addressFormatted = 'Av. Corrientes 1234, CABA, AR';
  runSQL(`
    INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, lat, lng, display_order, source, country)
    VALUES ('${patientId}', '${addressFormatted}', '${addressFormatted}', -34.6037, -58.3816, 1, 'manual', 'AR')
  `);
  const addressId = firstLine(runSQL(`SELECT id FROM patient_addresses WHERE patient_id = '${patientId}' LIMIT 1`));

  runSQL(`
    INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by)
    VALUES ('${patientId}', 'AT', '${addressId}', 'AR', '${TASK_PREFIX}', '${TASK_PREFIX}')
  `);
  const serviceId = firstLine(
    runSQL(`SELECT id FROM patient_contracted_services WHERE patient_id = '${patientId}' LIMIT 1`),
  );

  runSQL(`
    INSERT INTO job_postings (title, contracted_service_id, patient_id, country)
    VALUES ('${TASK_PREFIX}vaga', '${serviceId}', '${patientId}', 'AR')
  `);
  const jobId = firstLine(runSQL(`SELECT id FROM job_postings WHERE contracted_service_id = '${serviceId}' LIMIT 1`));

  runSQL(`
    INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
    VALUES ('${serviceId}', 1, '09:00', '11:00', '${TASK_PREFIX}', '${TASK_PREFIX}')
  `);
  const slotId = firstLine(
    runSQL(`SELECT id FROM patient_itinerary_slot WHERE contracted_service_id = '${serviceId}' LIMIT 1`),
  );

  const titularWorkerId = mkWorker('titular', jobId, 'Alberto', 'Marquez', 'CAREGIVER');
  const substituteWorkerId = mkWorker('substituto', jobId, 'Ana', 'Joulie', 'AT');
  const permanentWorkerId = mkWorker('permanente', jobId, 'Marcel', 'Araujo', 'AT');
  const freeSubstituteWorkerId = mkWorker('livre', jobId, 'Paula', 'Antonia', 'CAREGIVER');

  const nextMonday = firstLine(
    runSQL(`
      SELECT to_char(min(g)::date, 'YYYY-MM-DD')
        FROM generate_series(
          (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date + 1,
          (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date + 7,
          interval '1 day'
        ) g
       WHERE extract(dow FROM g) = 1
    `),
  );

  return { patientId, serviceId, jobId, slotId, addressLabel: addressFormatted, titularWorkerId, substituteWorkerId, permanentWorkerId, freeSubstituteWorkerId, nextMonday, names: { titular: 'Alberto Marquez', substitute: 'Ana Joulie', permanent: 'Marcel Araujo', free: 'Paula Antonia' } };
}

/** Aloca o titular no slot direto por SQL (equivalente ao POST .../allocations, mais rápido no seed). */
export function seedTitularAllocation(seed: ItinerarySeed): void {
  const applicationId = firstLine(
    runSQL(`SELECT id FROM worker_job_applications WHERE worker_id = '${seed.titularWorkerId}' AND job_posting_id = '${seed.jobId}'`),
  );
  runSQL(`
    INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, status, created_by, updated_by)
    VALUES ('${seed.slotId}', '${seed.titularWorkerId}', '${applicationId}', (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'ACTIVE', '${TASK_PREFIX}', '${TASK_PREFIX}')
  `);
}

/**
 * D445 (rodada 2, alternativo 1): dá ao `substituteWorkerId` uma alocação ACTIVE, na MESMA faixa
 * horária (weekday=1, 09:00-11:00), num serviço de OUTRO paciente — invariante 4 ("um prestador
 * nunca está em dois lugares ao mesmo tempo... qualquer serviço de qualquer paciente"): o gatilho
 * de conflito é GLOBAL por worker_id, não por serviço/paciente. Ele continua "Selecionado" no
 * serviço do `seed` (a candidatura dele é lá) — só ganha uma 2ª alocação, em serviço alheio, que
 * colide na hora de virar titular/substituto no serviço do `seed`.
 */
export function seedConflictForSubstitute(seed: ItinerarySeed): void {
  const clickupTaskId = `${TASK_PREFIX}p2`;
  runSQL(`
    INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
    VALUES ('${clickupTaskId}', 'Itinerario', 'ConflitoPlaywright', 'AR', 'ACTIVE')
  `);
  const patient2Id = firstLine(runSQL(`SELECT id FROM patients WHERE clickup_task_id = '${clickupTaskId}'`));

  runSQL(`
    INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, lat, lng, display_order, source, country)
    VALUES ('${patient2Id}', 'Otra Direccion 999, CABA, AR', 'Otra Direccion 999, CABA', -34.60, -58.38, 1, 'manual', 'AR')
  `);
  const address2Id = firstLine(runSQL(`SELECT id FROM patient_addresses WHERE patient_id = '${patient2Id}' LIMIT 1`));

  runSQL(`
    INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by)
    VALUES ('${patient2Id}', 'AT', '${address2Id}', 'AR', '${TASK_PREFIX}', '${TASK_PREFIX}')
  `);
  const service2Id = firstLine(runSQL(`SELECT id FROM patient_contracted_services WHERE patient_id = '${patient2Id}' LIMIT 1`));

  runSQL(`INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ('${TASK_PREFIX}vaga2', '${service2Id}', '${patient2Id}', 'AR')`);
  const job2Id = firstLine(runSQL(`SELECT id FROM job_postings WHERE contracted_service_id = '${service2Id}' LIMIT 1`));

  runSQL(`
    INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
    VALUES ('${service2Id}', 1, '09:00', '11:00', '${TASK_PREFIX}', '${TASK_PREFIX}')
  `);
  const slot2Id = firstLine(runSQL(`SELECT id FROM patient_itinerary_slot WHERE contracted_service_id = '${service2Id}' LIMIT 1`));

  runSQL(`
    INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
    VALUES ('${seed.substituteWorkerId}', '${job2Id}', 'QUICK_RESPONSE_TEAM', 'import')
  `);
  const app2Id = firstLine(
    runSQL(`SELECT id FROM worker_job_applications WHERE worker_id = '${seed.substituteWorkerId}' AND job_posting_id = '${job2Id}'`),
  );
  runSQL(`
    INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, status, created_by, updated_by)
    VALUES ('${slot2Id}', '${seed.substituteWorkerId}', '${app2Id}', (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'ACTIVE', '${TASK_PREFIX}', '${TASK_PREFIX}')
  `);
}


/** Estado do paciente (`patients.status`) — prova de banco de que o reemplazo não o mexe hoje. */
export function readPatientStatus(seed: ItinerarySeed): string {
  return firstLine(runSQL(`SELECT status FROM patients WHERE id = '${seed.patientId}'`));
}

export interface AssignmentRow {
  workerId: string;
  validFrom: string;
  validTo: string | null;
  status: string;
}

/** Alocações do slot do seed (todas, qualquer status), da mais antiga para a mais nova — prova de banco, não de tela. */
export function readAssignments(seed: ItinerarySeed): AssignmentRow[] {
  const out = runSQL(`
    SELECT worker_id || '|' || valid_from || '|' || coalesce(valid_to::text, '') || '|' || status
      FROM patient_itinerary_assignment WHERE slot_id = '${seed.slotId}' ORDER BY created_at, id
  `);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [workerId, validFrom, validTo, status] = l.split('|');
      return { workerId, validFrom, validTo: validTo || null, status };
    });
}

/** Ausências abertas (não canceladas) das alocações do slot do seed: `on_date|substitute_worker_id`. */
export function readOpenAbsences(seed: ItinerarySeed): { onDate: string; substituteWorkerId: string | null }[] {
  const out = runSQL(`
    SELECT ab.on_date || '|' || coalesce(ab.substitute_worker_id::text, '')
      FROM patient_itinerary_absence ab JOIN patient_itinerary_assignment a ON a.id = ab.assignment_id
     WHERE a.slot_id = '${seed.slotId}' AND ab.cancelled_at IS NULL ORDER BY ab.on_date
  `);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [onDate, sub] = l.split('|');
      return { onDate, substituteWorkerId: sub || null };
    });
}

export function cleanupItinerary(seed: ItinerarySeed): void {
  // Por PREFIXO (não só `seed.patientId`/`seed.serviceId`): `seedConflictForSubstitute` cria um 2º
  // paciente/serviço próprios (`${TASK_PREFIX}p2`), fora do `seed` original.
  // O registro de trocas (migration 494) referencia alocação/ausência/prestador sem cascata: sai PRIMEIRO.
  runSQL(`
    DELETE FROM patient_itinerary_change_log l USING patient_contracted_services pcs
     WHERE l.contracted_service_id = pcs.id AND pcs.created_by = '${TASK_PREFIX}'
  `);
  runSQL(`
    DELETE FROM patient_itinerary_assignment a USING patient_itinerary_slot s, patient_contracted_services pcs
     WHERE a.slot_id = s.id AND s.contracted_service_id = pcs.id AND pcs.created_by = '${TASK_PREFIX}'
  `);
  runSQL(`DELETE FROM job_postings WHERE title LIKE '${TASK_PREFIX}%'`);
  runSQL(`DELETE FROM patients WHERE clickup_task_id LIKE '${TASK_PREFIX}%'`);
  runSQL(`DELETE FROM workers WHERE auth_uid LIKE '${TASK_PREFIX}%'`);
  void seed;
}
