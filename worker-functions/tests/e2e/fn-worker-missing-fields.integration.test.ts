/**
 * fn-worker-missing-fields.integration.test.ts
 *
 * Testes de integração com banco REAL para fn_worker_missing_fields().
 *
 * Cobre TODAS as branches da função SQL (migration 212):
 *   - worker inexistente → ["worker_not_found"]
 *   - worker mesclado (merged_into_id != null) → ["worker_not_found"]
 *   - cada grupo de campo pessoal faltando (first_name, phone, etc.)
 *   - worker_service_areas ausente
 *   - worker_availability ausente
 *   - worker_documents: não-AT com básicos incompletos
 *   - worker_documents: AT sem resume_cv e at_certificate
 *   - worker_documents: não-AT com apenas frente+antecedentes (sem verso) → NÃO falta
 *   - worker_documents: AT com todos obrigatórios (sem verso) → NÃO falta
 *   - worker_documents: AT com apenas frente+antecedentes (sem cv+cert+verso) → FALTA
 *   - worker completo (sem verso) → [] (elegível)
 *
 * identity_document_back_url: OPCIONAL desde migration 212. Ausência do verso
 * NÃO deve aparecer em missing_fields_at_attempt para nenhuma profissão.
 *
 * Não usa API — acessa pool diretamente.
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ALL_WORKER_IDS: string[] = [];

// ── Helpers ────────────────────────────────────────────────────────────

async function makeWorker(
  status: 'INCOMPLETE_REGISTER' | 'DISABLED' | 'REGISTERED',
  tag: string,
  profession?: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    profession
      ? `INSERT INTO workers (auth_uid, email, status, country, timezone, profession)
         VALUES ($1, $2, $3, 'AR', 'America/Argentina/Buenos_Aires', $4) RETURNING id`
      : `INSERT INTO workers (auth_uid, email, status, country, timezone)
         VALUES ($1, $2, $3, 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
    profession
      ? [`uid-fn-${SUFFIX}-${tag}`, `fn-${SUFFIX}-${tag}@fn.test`, status, profession]
      : [`uid-fn-${SUFFIX}-${tag}`, `fn-${SUFFIX}-${tag}@fn.test`, status],
  );
  ALL_WORKER_IDS.push(rows[0].id);
  return rows[0].id;
}

async function callFn(workerId: string): Promise<string[]> {
  const { rows } = await pool.query<{ result: unknown }>(
    `SELECT fn_worker_missing_fields($1::uuid) AS result`,
    [workerId],
  );
  const raw = rows[0]?.result;
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') return JSON.parse(raw) as string[];
  return [];
}

// ── Teardown ───────────────────────────────────────────────────────────

afterAll(async () => {
  if (ALL_WORKER_IDS.length) {
    await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = ANY($1::uuid[])`, [ALL_WORKER_IDS]);
    await pool.query(`DELETE FROM worker_availability WHERE worker_id = ANY($1::uuid[])`, [ALL_WORKER_IDS]);
    await pool.query(`DELETE FROM worker_documents WHERE worker_id = ANY($1::uuid[])`, [ALL_WORKER_IDS]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [ALL_WORKER_IDS]);
  }
  await pool.end();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('fn_worker_missing_fields — branches SQL (banco real)', () => {
  it('worker inexistente → ["worker_not_found"]', async () => {
    const result = await callFn('00000000-0000-0000-0000-000000000004');
    expect(result).toEqual(['worker_not_found']);
  });

  it('worker mesclado (merged_into_id != null) → contém "worker_not_found"', async () => {
    const w1 = await makeWorker('REGISTERED', 'merged-1');
    const w2 = await makeWorker('REGISTERED', 'merged-2');

    await pool.query(`UPDATE workers SET merged_into_id = $1 WHERE id = $2`, [w2, w1]);
    const result = await callFn(w1);
    await pool.query(`UPDATE workers SET merged_into_id = NULL WHERE id = $1`, [w1]);

    expect(result).toContain('worker_not_found');
  });

  it('worker sem first_name_encrypted → inclui "first_name"', async () => {
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'no-fname');
    expect(await callFn(workerId)).toContain('first_name');
  });

  it('worker sem phone → inclui "phone"', async () => {
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'no-phone');
    expect(await callFn(workerId)).toContain('phone');
  });

  it('worker sem worker_service_areas → inclui "worker_service_areas"', async () => {
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'no-sa');
    expect(await callFn(workerId)).toContain('worker_service_areas');
  });

  it('worker sem worker_availability → inclui "worker_availability"', async () => {
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'no-av');
    expect(await callFn(workerId)).toContain('worker_availability');
  });

  it('worker sem worker_documents → inclui "worker_documents"', async () => {
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'no-docs');
    expect(await callFn(workerId)).toContain('worker_documents');
  });

  it('AT com apenas frente+antecedentes (sem resume_cv + at_certificate + verso) → inclui "worker_documents"', async () => {
    // verso é opcional; a ausência de cv e cert AT é que bloqueia o AT
    const workerId = await makeWorker('INCOMPLETE_REGISTER', 'at-no-extra', 'AT');

    await pool.query(
      `INSERT INTO worker_documents (worker_id, identity_document_url, criminal_record_url)
       VALUES ($1, 'http://e.com/id', 'http://e.com/cr')`,
      [workerId],
    );

    expect(await callFn(workerId)).toContain('worker_documents');
  });

  it('não-AT com frente+antecedentes (SEM verso) → NÃO inclui "worker_documents" (verso opcional desde mig 212)', async () => {
    // Prova central da migration 212: verso ausente não bloqueia
    const workerId = await makeWorker('REGISTERED', 'caregiver-no-back', 'CAREGIVER');

    await pool.query(
      `INSERT INTO worker_documents (worker_id, identity_document_url, criminal_record_url)
       VALUES ($1, 'http://e.com/id', 'http://e.com/cr')`,
      [workerId],
    );

    expect(await callFn(workerId)).not.toContain('worker_documents');
  });

  it('não-AT com frente+verso+antecedentes (verso presente) → NÃO inclui "worker_documents"', async () => {
    // verso presente ainda é aceito normalmente (é opcional, não proibido)
    const workerId = await makeWorker('REGISTERED', 'caregiver-with-back', 'CAREGIVER');

    await pool.query(
      `INSERT INTO worker_documents (worker_id, identity_document_url, identity_document_back_url, criminal_record_url)
       VALUES ($1, 'http://e.com/id', 'http://e.com/id-back', 'http://e.com/cr')`,
      [workerId],
    );

    expect(await callFn(workerId)).not.toContain('worker_documents');
  });

  it('AT com frente+antecedentes+cv+cert (SEM verso) → NÃO inclui "worker_documents" (verso opcional desde mig 212)', async () => {
    // AT: verso ausente não bloqueia; cv+cert presentes satisfazem o gate
    const workerId = await makeWorker('REGISTERED', 'at-no-back', 'AT');

    await pool.query(
      `INSERT INTO worker_documents
         (worker_id, identity_document_url, criminal_record_url,
          resume_cv_url, at_certificate_url)
       VALUES ($1, 'http://e.com/id', 'http://e.com/cr',
               'http://e.com/cv', 'http://e.com/cert')`,
      [workerId],
    );

    expect(await callFn(workerId)).not.toContain('worker_documents');
  });

  it('AT com todos os campos (com verso) → NÃO inclui "worker_documents"', async () => {
    // Verso presente ainda é aceito
    const workerId = await makeWorker('REGISTERED', 'at-all-docs', 'AT');

    await pool.query(
      `INSERT INTO worker_documents
         (worker_id, identity_document_url, identity_document_back_url,
          criminal_record_url, resume_cv_url, at_certificate_url)
       VALUES ($1, 'http://e.com/id', 'http://e.com/id-back', 'http://e.com/cr',
               'http://e.com/cv', 'http://e.com/cert')`,
      [workerId],
    );

    expect(await callFn(workerId)).not.toContain('worker_documents');
  });

  it('worker CAREGIVER completo (SEM verso) → [] (elegível — mig 212)', async () => {
    // Prova end-to-end: worker completamente preenchido SEM verso → array vazio
    const workerId = await makeWorker('REGISTERED', 'complete-no-back', 'CAREGIVER');

    await pool.query(
      `UPDATE workers SET
         first_name_encrypted      = 'enc-fname',
         last_name_encrypted       = 'enc-lname',
         sex_encrypted             = 'enc-sex',
         gender_encrypted          = 'enc-gender',
         birth_date_encrypted      = 'enc-bd',
         document_number_encrypted = 'enc-doc',
         document_type             = 'DNI',
         languages_encrypted       = 'enc-lang',
         phone                     = '+5411888888888',
         knowledge_level           = 'BASIC',
         title_certificate         = 'DEGREE',
         years_experience          = '3-5',
         experience_types          = ARRAY['TEA','TLP'],
         preferred_types           = ARRAY['TEA'],
         preferred_age_range       = ARRAY['CHILD']
       WHERE id = $1`,
      [workerId],
    );

    await pool.query(
      `INSERT INTO worker_service_areas (worker_id, address_line, radius_km)
       VALUES ($1, 'Av. Corrientes 1234', 10)`,
      [workerId],
    );

    await pool.query(
      `INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone)
       VALUES ($1, 1, '08:00', '18:00', 'America/Argentina/Buenos_Aires')`,
      [workerId],
    );

    // Somente frente + antecedentes — sem verso
    await pool.query(
      `INSERT INTO worker_documents
         (worker_id, identity_document_url, criminal_record_url)
       VALUES ($1, 'http://e.com/id', 'http://e.com/cr')`,
      [workerId],
    );

    expect(await callFn(workerId)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Spec 067 / F1 — o dono com DOIS limiares (migration 546)
//   padrão (cadastro completo)  = saída idêntica à da migration 212
//   estrito / apto              = padrão + documentos obrigatórios VALIDADOS
// ═══════════════════════════════════════════════════════════════════════

type DocState = 'none' | 'unvalidated' | 'validated';

const VALIDATION = JSON.stringify({ validated_by: 'qa@enlite.test', validated_at: '2026-10-22T00:00:00Z' });

/** Preenche cadastro + área + disponibilidade (tudo menos documentos) de um worker existente. */
let phoneSeq = 0;
async function fillRegistration(workerId: string): Promise<void> {
  phoneSeq += 1; // phone é UNIQUE em workers
  const phone = `+54119${String(Date.now()).slice(-6)}${String(phoneSeq).padStart(3, '0')}`;
  await pool.query(
    `UPDATE workers SET
       first_name_encrypted = 'enc-fname', last_name_encrypted = 'enc-lname', sex_encrypted = 'enc-sex',
       gender_encrypted = 'enc-gender', birth_date_encrypted = 'enc-bd', document_number_encrypted = 'enc-doc',
       document_type = 'DNI', languages_encrypted = 'enc-lang', phone = $2,
       knowledge_level = 'BASIC', title_certificate = 'DEGREE', years_experience = '3-5',
       experience_types = ARRAY['TEA'], preferred_types = ARRAY['TEA'], preferred_age_range = ARRAY['CHILD']
     WHERE id = $1`,
    [workerId, phone],
  );
  await pool.query(
    `INSERT INTO worker_service_areas (worker_id, address_line, radius_km) VALUES ($1, 'Av. Corrientes 1234', 10)`,
    [workerId],
  );
  await pool.query(
    `INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone)
     VALUES ($1, 1, '08:00', '18:00', 'America/Argentina/Buenos_Aires')`,
    [workerId],
  );
}

/**
 * Worker com cadastro completo e os 4 documentos (AT) / 2 (CUIDADOR) enviados.
 * `docs`: none = sem linha em worker_documents; unvalidated = URLs sem chave; validated = URLs + chaves dos obrigatórios.
 */
async function makeWorkerWithDocs(
  status: 'INCOMPLETE_REGISTER' | 'REGISTERED',
  tag: string,
  profession: 'AT' | 'CAREGIVER',
  docs: DocState,
): Promise<string> {
  const id = await makeWorker(status, tag, profession);
  await fillRegistration(id);
  if (docs === 'none') return id;
  const slugs = profession === 'AT'
    ? ['identity_document', 'criminal_record', 'resume_cv', 'at_certificate']
    : ['identity_document', 'criminal_record'];
  const validations = docs === 'validated'
    ? JSON.stringify(Object.fromEntries(slugs.map((s) => [s, JSON.parse(VALIDATION)])))
    : '{}';
  await pool.query(
    `INSERT INTO worker_documents
       (worker_id, identity_document_url, criminal_record_url, resume_cv_url, at_certificate_url, document_validations)
     VALUES ($1, 'http://e.com/id', 'http://e.com/cr', $2, $3, $4::jsonb)`,
    [id, profession === 'AT' ? 'http://e.com/cv' : null, profession === 'AT' ? 'http://e.com/cert' : null, validations],
  );
  return id;
}

async function callStrict(workerId: string): Promise<string[]> {
  const { rows } = await pool.query<{ result: string[] }>(
    `SELECT fn_worker_missing_fields($1::uuid, true) AS result`,
    [workerId],
  );
  return rows[0].result;
}

async function isApto(workerId: string): Promise<boolean> {
  const { rows } = await pool.query<{ apto: boolean }>(`SELECT fn_worker_is_apto($1::uuid) AS apto`, [workerId]);
  return rows[0].apto;
}

describe('A1 — matriz profissão × documento × modo (spec 067)', () => {
  const casos: Array<{
    prof: 'AT' | 'CAREGIVER'; docs: DocState;
    padrao: string[]; estrito: string[]; apto: boolean;
  }> = [
    { prof: 'CAREGIVER', docs: 'none', padrao: ['worker_documents'], estrito: ['worker_documents'], apto: false },
    { prof: 'CAREGIVER', docs: 'unvalidated', padrao: [], estrito: ['unvalidated_identity_document', 'unvalidated_criminal_record'], apto: false },
    { prof: 'CAREGIVER', docs: 'validated', padrao: [], estrito: [], apto: true },
    { prof: 'AT', docs: 'none', padrao: ['worker_documents'], estrito: ['worker_documents'], apto: false },
    {
      prof: 'AT', docs: 'unvalidated', padrao: [],
      estrito: ['unvalidated_identity_document', 'unvalidated_criminal_record', 'unvalidated_resume_cv', 'unvalidated_at_certificate'],
      apto: false,
    },
    { prof: 'AT', docs: 'validated', padrao: [], estrito: [], apto: true },
  ];

  it.each(casos)('$prof / $docs → padrão $padrao · estrito $estrito · apto $apto', async ({ prof, docs, padrao, estrito, apto }) => {
    const id = await makeWorkerWithDocs('REGISTERED', `a1-${prof}-${docs}`, prof, docs);
    expect(await callFn(id)).toEqual(padrao);
    expect(await callStrict(id)).toEqual(estrito);
    expect(await isApto(id)).toBe(apto);
  });

  it('CUIDADOR não exige validação de CV/certificado de AT (só os 2 básicos)', async () => {
    const id = await makeWorkerWithDocs('REGISTERED', 'a1-cg-extra', 'CAREGIVER', 'unvalidated');
    await pool.query(
      `UPDATE worker_documents SET resume_cv_url = 'http://e.com/cv', at_certificate_url = 'http://e.com/cert' WHERE worker_id = $1`,
      [id],
    );
    expect(await callStrict(id)).toEqual(['unvalidated_identity_document', 'unvalidated_criminal_record']);
  });

  it('um documento validado e o outro não → só o que falta aparece', async () => {
    const id = await makeWorkerWithDocs('REGISTERED', 'a1-meio', 'CAREGIVER', 'unvalidated');
    await pool.query(
      `UPDATE worker_documents SET document_validations = $2::jsonb WHERE worker_id = $1`,
      [id, JSON.stringify({ identity_document: JSON.parse(VALIDATION) })],
    );
    expect(await callStrict(id)).toEqual(['unvalidated_criminal_record']);
    expect(await isApto(id)).toBe(false);
  });

  it('fn_worker_is_apto: status ≠ REGISTERED, mesclado e inexistente → false mesmo com tudo validado', async () => {
    const inc = await makeWorkerWithDocs('INCOMPLETE_REGISTER', 'a1-inc', 'CAREGIVER', 'validated');
    expect(await isApto(inc)).toBe(false);

    const mesclado = await makeWorkerWithDocs('REGISTERED', 'a1-mesc', 'CAREGIVER', 'validated');
    const destino = await makeWorker('REGISTERED', 'a1-mesc-dest');
    await pool.query(`UPDATE workers SET merged_into_id = $1 WHERE id = $2`, [destino, mesclado]);
    expect(await isApto(mesclado)).toBe(false);

    expect(await isApto('00000000-0000-0000-0000-000000000067')).toBe(false);
  });

  it('modo estrito de worker inexistente → ["worker_not_found"]', async () => {
    expect(await callStrict('00000000-0000-0000-0000-000000000068')).toEqual(['worker_not_found']);
  });
});

describe('A8 (iv) — modo padrão idêntico, byte a byte, à função da migration 212', () => {
  it('fn_worker_missing_fields(uuid) = pg_temp.fn_ref_212(uuid) para uma massa variada', async () => {
    // O corpo de REFERÊNCIA é lido do arquivo da 212 (não digitado aqui): o teste compara com o texto que está em produção.
    const sql212 = fs.readFileSync(path.join(__dirname, '../../migrations/212_relax_dni_verso.sql'), 'utf8');
    const m = sql212.match(/CREATE OR REPLACE FUNCTION public\.fn_worker_missing_fields\(p_worker_id UUID\)[\s\S]*?\$func\$;/);
    expect(m).not.toBeNull();
    const ref = m![0].replace('public.fn_worker_missing_fields(p_worker_id UUID)', 'pg_temp.fn_ref_212(p_worker_id UUID)');

    // massa: cada estado relevante, incluindo AT sem extras, CUIDADOR validado e não validado, vazio, mesclado e inexistente
    const ids: string[] = [
      await makeWorker('INCOMPLETE_REGISTER', 'ref-vazio'),
      await makeWorker('INCOMPLETE_REGISTER', 'ref-vazio-at', 'AT'),
      await makeWorkerWithDocs('REGISTERED', 'ref-cg-none', 'CAREGIVER', 'none'),
      await makeWorkerWithDocs('REGISTERED', 'ref-cg-unv', 'CAREGIVER', 'unvalidated'),
      await makeWorkerWithDocs('REGISTERED', 'ref-cg-val', 'CAREGIVER', 'validated'),
      await makeWorkerWithDocs('REGISTERED', 'ref-at-none', 'AT', 'none'),
      await makeWorkerWithDocs('REGISTERED', 'ref-at-unv', 'AT', 'unvalidated'),
      await makeWorkerWithDocs('REGISTERED', 'ref-at-val', 'AT', 'validated'),
    ];
    const parcialAt = await makeWorkerWithDocs('REGISTERED', 'ref-at-parcial', 'AT', 'unvalidated');
    await pool.query(`UPDATE worker_documents SET resume_cv_url = NULL WHERE worker_id = $1`, [parcialAt]);
    ids.push(parcialAt);
    const mesclado = await makeWorkerWithDocs('REGISTERED', 'ref-mesc', 'CAREGIVER', 'validated');
    await pool.query(`UPDATE workers SET merged_into_id = $1 WHERE id = $2`, [ids[0], mesclado]);
    ids.push(mesclado, '00000000-0000-0000-0000-000000000069');

    const client = await pool.connect();
    try {
      await client.query(ref);
      let comparados = 0;
      const saidasDistintas = new Set<string>();
      for (const id of ids) {
        const nova = await client.query<{ r: string }>(`SELECT fn_worker_missing_fields($1::uuid)::text AS r`, [id]);
        const velha = await client.query<{ r: string }>(`SELECT pg_temp.fn_ref_212($1::uuid)::text AS r`, [id]);
        expect(nova.rows[0].r).toBe(velha.rows[0].r);
        saidasDistintas.add(nova.rows[0].r);
        comparados += 1;
      }
      // contagem zero é falha: provar que o laço comparou a massa inteira e que a massa tem saídas diferentes entre si
      expect(comparados).toBe(ids.length);
      expect(ids.length).toBeGreaterThanOrEqual(11);
      expect(saidasDistintas.size).toBeGreaterThanOrEqual(4);
    } finally {
      client.release();
    }
  });

  it('o modo padrão NUNCA emite "unvalidated_*" (nem com documento sem validação)', async () => {
    const id = await makeWorkerWithDocs('REGISTERED', 'padrao-sem-unv', 'AT', 'unvalidated');
    expect((await callFn(id)).filter((t) => t.startsWith('unvalidated_'))).toEqual([]);
  });
});

describe('Guard fn_guard_registered_status — decide pelo dono, lendo a linha nova (SUP-1)', () => {
  it('UPDATE que preenche os campos E muda status para REGISTERED no mesmo comando PASSA', async () => {
    const id = await makeWorker('INCOMPLETE_REGISTER', 'guard-mesmo-update', 'CAREGIVER');
    // satélites já existem; os campos do cadastro chegam no MESMO UPDATE que muda o status
    await pool.query(`INSERT INTO worker_service_areas (worker_id, address_line, radius_km) VALUES ($1, 'Av. X 1', 5)`, [id]);
    await pool.query(
      `INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone)
       VALUES ($1, 2, '08:00', '18:00', 'America/Argentina/Buenos_Aires')`,
      [id],
    );
    await pool.query(
      `INSERT INTO worker_documents (worker_id, identity_document_url, criminal_record_url) VALUES ($1, 'http://e.com/id', 'http://e.com/cr')`,
      [id],
    );
    await pool.query(
      `UPDATE workers SET
         status = 'REGISTERED',
         first_name_encrypted = 'a', last_name_encrypted = 'b', sex_encrypted = 'c', gender_encrypted = 'd',
         birth_date_encrypted = 'e', document_number_encrypted = 'f', document_type = 'DNI', languages_encrypted = 'g',
         phone = $2, knowledge_level = 'BASIC', title_certificate = 'DEGREE', years_experience = '1-2',
         experience_types = ARRAY['TEA'], preferred_types = ARRAY['TEA'], preferred_age_range = ARRAY['CHILD']
       WHERE id = $1`,
      [id, `+54118${String(Date.now()).slice(-6)}001`],
    );
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM workers WHERE id = $1`, [id]);
    expect(rows[0].status).toBe('REGISTERED');
  });

  it('REGISTERED sem cadastro → recusa, com os tokens faltantes na mensagem (sem PII)', async () => {
    const id = await makeWorker('INCOMPLETE_REGISTER', 'guard-recusa', 'CAREGIVER');
    await expect(pool.query(`UPDATE workers SET status = 'REGISTERED' WHERE id = $1`, [id]))
      .rejects.toThrow(/Cadastro incompleto.*first_name.*worker_documents/s);
  });

  it('REGISTERED com cadastro completo mas documento SEM validação → PASSA (o guard usa o modo padrão)', async () => {
    const id = await makeWorkerWithDocs('INCOMPLETE_REGISTER', 'guard-sem-validacao', 'CAREGIVER', 'unvalidated');
    await pool.query(`UPDATE workers SET status = 'REGISTERED' WHERE id = $1`, [id]);
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM workers WHERE id = $1`, [id]);
    expect(rows[0].status).toBe('REGISTERED');
  });

  it('worker mesclado → recusa com a mensagem própria', async () => {
    const id = await makeWorkerWithDocs('INCOMPLETE_REGISTER', 'guard-mesc', 'CAREGIVER', 'validated');
    const destino = await makeWorker('INCOMPLETE_REGISTER', 'guard-mesc-dest');
    await pool.query(`UPDATE workers SET merged_into_id = $1 WHERE id = $2`, [destino, id]);
    await expect(pool.query(`UPDATE workers SET status = 'REGISTERED' WHERE id = $1`, [id]))
      .rejects.toThrow(/mesclado/);
  });

  it('o corpo do guard não carrega regra própria (nenhuma cópia de coluna de documento)', async () => {
    const { rows } = await pool.query<{ def: string }>(
      `SELECT pg_get_functiondef('public.fn_guard_registered_status'::regproc) AS def`,
    );
    expect(rows[0].def).not.toContain('identity_document_url');
    expect(rows[0].def).not.toContain('criminal_record_url');
    expect(rows[0].def).toContain('fn_worker_missing_fields_of');
  });
});
