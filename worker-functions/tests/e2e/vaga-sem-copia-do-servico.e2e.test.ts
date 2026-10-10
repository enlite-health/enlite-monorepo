/**
 * F7 (change `vaga-le-do-servico-contratado`) — a CHECK `job_postings_service_owns_fields_chk` (migration 511) no banco REAL:
 * vaga COM serviço contratado não pode ter horário, quantidade nem faixa etária PRÓPRIOS; vaga MANUAL pode.
 *
 * É o teste que MORRE se desfizerem a constraint (ou a trocarem `AND` por `OR`): se alguém reabrir uma escrita da cópia, o INSERT/UPDATE
 * leva `23514` aqui e em produção. Substitui também a prova antiga do `singleSource` ("a cópia stale preenchida é ignorada pelo leitor"):
 * a cópia stale não pode mais existir, e é ESTE arquivo que prova que não pode.
 *
 * DML pela sessão `app_runtime` com identidade AR (a constraint vale para qualquer role; o semeio de paciente/serviço vai pela dona).
 * Nenhum canal real: só SQL.
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

const ADMIN_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TAG = 'vls-f7t';
const CONSTRAINT = 'job_postings_service_owns_fields_chk';
const SCHEDULE = JSON.stringify([{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }]);

/** Valor próprio de cada uma das 4 colunas protegidas (o tipo é o da coluna: jsonb, text, int, int). */
const OWN_VALUE: Record<'schedule' | 'providers_needed' | 'age_range_min' | 'age_range_max', { sql: string; param: unknown }> = {
  schedule: { sql: '$1::jsonb', param: SCHEDULE },
  providers_needed: { sql: '$1', param: '2' },
  age_range_min: { sql: '$1', param: 25 },
  age_range_max: { sql: '$1', param: 40 },
};
const COLUMNS = Object.keys(OWN_VALUE) as Array<keyof typeof OWN_VALUE>;

let admin: Pool;
let runtime: Pool;
let caseSeq = 950000;
let serviceId: string;

async function wipe(): Promise<void> {
  await admin.query(`DELETE FROM job_postings WHERE title LIKE 'CASO 95%'`);
  await admin.query(`DELETE FROM patients WHERE clickup_task_id LIKE '${TAG}-%'`); // cascata: serviços
}

/** Roda o SQL e devolve o erro do Postgres (ou null), para afirmar `code`/`constraint` e não só "falhou". */
async function pgError(sql: string, params: unknown[] = []): Promise<{ code?: string; constraint?: string } | null> {
  try {
    await runtime.query(sql, params);
    return null;
  } catch (e) {
    return e as { code?: string; constraint?: string };
  }
}

/** INSERT mínimo de vaga; `extraCol` liga UMA coluna protegida ao valor próprio. */
async function insertVaga(opts: { withService: boolean; own?: keyof typeof OWN_VALUE }): Promise<{ id: string; err: Awaited<ReturnType<typeof pgError>> }> {
  const id = randomUUID();
  const caseNumber = caseSeq++;
  const extraCols = opts.own ? `, ${opts.own}` : '';
  const extraVal = opts.own ? `, ${OWN_VALUE[opts.own].sql.replace('$1', '$4')}` : '';
  const params: unknown[] = [id, `CASO ${caseNumber}`, opts.withService ? serviceId : null];
  if (opts.own) params.push(OWN_VALUE[opts.own].param);
  const err = await pgError(
    `INSERT INTO job_postings (id, title, contracted_service_id, status, is_draft, required_professions, country, is_test${extraCols})
     VALUES ($1, $2, $3, 'SEARCHING', false, ARRAY['AT'], 'AR', true${extraVal})`,
    params,
  );
  return { id, err };
}

beforeAll(async () => {
  admin = new Pool({ connectionString: ADMIN_URL });
  runtime = new Pool({
    connectionString: ADMIN_URL,
    options: `-c role=app_runtime -c app.user_country=AR -c app.user_uid=${TAG}-uid`,
    max: 2,
  });
  await wipe();
  const patientId = randomUUID();
  serviceId = randomUUID();
  await admin.query(
    `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, case_number) VALUES ($1, $2, 'Paciente', 'Sem Copia', 'AR', $3)`,
    [patientId, `${TAG}-${patientId}`, caseSeq++],
  );
  await admin.query(
    `INSERT INTO patient_contracted_services (id, patient_id, service_code, country, created_by, updated_by, schedule, providers_needed, provider_age_band)
     VALUES ($1, $2, 'AT', 'AR', $3, $3, $4::jsonb, 3, 'AGE_30_45')`,
    [serviceId, patientId, TAG, SCHEDULE],
  );
});

afterAll(async () => {
  await wipe();
  await Promise.all([admin.end(), runtime.end()]);
});

describe('job_postings_service_owns_fields_chk (migration 511, banco real)', () => {
  it('a sessão sob teste é app_runtime, não a dona', async () => {
    expect((await runtime.query(`SELECT current_user`)).rows[0].current_user).toBe('app_runtime');
  });

  it('(5) a constraint existe e está VALIDADA (convalidated = t)', async () => {
    const r = await admin.query(`SELECT convalidated FROM pg_constraint WHERE conname = $1`, [CONSTRAINT]);
    expect(r.rows).toEqual([{ convalidated: true }]); // 1 linha: contagem zero seria "não olhei", não "ok"
  });

  describe('(1) INSERT de vaga COM serviço e valor próprio -> 23514 na constraint', () => {
    it.each(COLUMNS)('%s próprio é recusado', async (col) => {
      const { err } = await insertVaga({ withService: true, own: col });
      expect(err).toMatchObject({ code: '23514', constraint: CONSTRAINT });
    });
  });

  describe('(2) UPDATE que seta valor próprio em vaga COM serviço -> 23514', () => {
    it.each(COLUMNS)('%s próprio é recusado', async (col) => {
      const { id, err: insertErr } = await insertVaga({ withService: true });
      expect(insertErr).toBeNull(); // controle: o estado de partida (4 NULL) existe, então o erro abaixo é do UPDATE
      const err = await pgError(`UPDATE job_postings SET ${col} = ${OWN_VALUE[col].sql} WHERE id = $2`, [OWN_VALUE[col].param, id]);
      expect(err).toMatchObject({ code: '23514', constraint: CONSTRAINT });
      const still = await admin.query(`SELECT ${col} FROM job_postings WHERE id = $1`, [id]);
      expect(still.rows[0][col]).toBeNull(); // e a linha não mudou
    });
  });

  describe('(3) vaga MANUAL (sem serviço) com valores próprios -> aceita', () => {
    it('as 4 colunas ao mesmo tempo', async () => {
      const id = randomUUID();
      const caseNumber = caseSeq++;
      const err = await pgError(
        `INSERT INTO job_postings (id, title, status, is_draft, required_professions, country, is_test, schedule, providers_needed, age_range_min, age_range_max)
         VALUES ($1, $2, 'SEARCHING', false, ARRAY['AT'], 'AR', true, $3::jsonb, '2', 25, 40)`,
        [id, `CASO ${caseNumber}`, SCHEDULE],
      );
      expect(err).toBeNull();
      const r = await admin.query(`SELECT providers_needed, age_range_min, age_range_max, schedule IS NOT NULL AS tem_horario FROM job_postings WHERE id = $1`, [id]);
      expect(r.rows[0]).toEqual({ providers_needed: '2', age_range_min: 25, age_range_max: 40, tem_horario: true });
    });

    it.each(COLUMNS)('%s sozinho', async (col) => {
      const { err } = await insertVaga({ withService: false, own: col });
      expect(err).toBeNull();
    });
  });

  describe('(4) vaga COM serviço e as 4 colunas NULL -> aceita', () => {
    it('INSERT sem nenhum valor próprio', async () => {
      const { id, err } = await insertVaga({ withService: true });
      expect(err).toBeNull();
      const r = await admin.query(`SELECT schedule, providers_needed, age_range_min, age_range_max FROM job_postings WHERE id = $1`, [id]);
      expect(r.rows[0]).toEqual({ schedule: null, providers_needed: null, age_range_min: null, age_range_max: null });
    });

    it('UPDATE de outro campo da vaga com serviço (daily_obs) continua passando', async () => {
      const { id } = await insertVaga({ withService: true });
      expect(await pgError(`UPDATE job_postings SET daily_obs = 'obs' WHERE id = $1`, [id])).toBeNull();
    });
  });

  describe('o caminho "vincular serviço a vaga que já tem valor próprio" também é barrado', () => {
    it('UPDATE contracted_service_id em vaga manual com horário próprio -> 23514', async () => {
      const { id, err: insertErr } = await insertVaga({ withService: false, own: 'schedule' });
      expect(insertErr).toBeNull();
      const err = await pgError(`UPDATE job_postings SET contracted_service_id = $1 WHERE id = $2`, [serviceId, id]);
      expect(err).toMatchObject({ code: '23514', constraint: CONSTRAINT });
    });
  });
});
