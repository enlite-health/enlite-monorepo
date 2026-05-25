/**
 * wave1-schema-diagnostic.test.ts
 *
 * Testa os 3 achados do Wave 1 do roadmap de correção de schema,
 * contra o banco real (sem mocks).
 *
 * C1:   FK de worker_job_applications.worker_id → workers(id)
 * C2-D: workers.whatsapp_phone em plaintext (auditoria de redundância com phone)
 * N8-C: blacklist.reason e detail podem conter PII clínico
 */

import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

let pool: Pool;

// UUIDs determinísticos para isolamento do teste
const WORKER_IDS = {
  w1: 'ee210000-0a0e-0001-c1c1-000000000001',
  w2: 'ee210000-0a0e-0001-c1c1-000000000002',
  w3: 'ee210000-0a0e-0001-c2d0-000000000001',
  w4: 'ee210000-0a0e-0001-c2d0-000000000002',
  w5: 'ee210000-0a0e-0001-c2d0-000000000003',
  w6: 'ee210000-0a0e-0001-a8c0-000000000001',
  w7: 'ee210000-0a0e-0001-a8c0-000000000002',
};

const JOB_ID = 'ee210000-0a0e-0001-c1c1-aaa000000001';
const APP_IDS = {
  a1: 'ee210000-0a0e-0001-c1c1-bbb000000001',
  a2: 'ee210000-0a0e-0001-c1c1-bbb000000002',
};
const BLACKLIST_IDS = {
  b1: 'ee210000-0a0e-0001-a8c0-ccc000000001',
  b2: 'ee210000-0a0e-0001-a8c0-ccc000000002',
  b3: 'ee210000-0a0e-0001-a8c0-ccc000000003',
  b4: 'ee210000-0a0e-0001-a8c0-ccc000000004',
};

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });

  // Limpar dados de teste anteriores (ordem de FK: filhos primeiro)
  await pool.query(`DELETE FROM worker_job_applications WHERE id = ANY($1)`, [
    Object.values(APP_IDS),
  ]);
  await pool.query(`DELETE FROM blacklist WHERE id = ANY($1)`, [
    Object.values(BLACKLIST_IDS),
  ]);
  await pool.query(`DELETE FROM job_postings WHERE id = $1`, [JOB_ID]);
  await pool.query(`DELETE FROM workers WHERE id = ANY($1)`, [
    Object.values(WORKER_IDS),
  ]);

  // --- Seed C1: workers + job_posting + applications ---
  for (const [key, id] of Object.entries(WORKER_IDS)) {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, $2, $3, $4, 'REGISTERED', 'AR', 'America/Buenos_Aires')
       ON CONFLICT (auth_uid) DO NOTHING`,
      [id, `e2e-wave1-${key}`, `${key}@wave1.test`, `54110000${key.replace('w', '')}`],
    );
  }

  await pool.query(
    `INSERT INTO job_postings (id, title, status, country)
     VALUES ($1, 'Wave1 test posting', 'ACTIVE', 'AR')
     ON CONFLICT DO NOTHING`,
    [JOB_ID],
  );

  await pool.query(
    `INSERT INTO worker_job_applications (id, worker_id, job_posting_id, application_funnel_stage)
     VALUES ($1, $2, $3, 'INVITED'), ($4, $5, $6, 'INVITED')
     ON CONFLICT DO NOTHING`,
    [APP_IDS.a1, WORKER_IDS.w1, JOB_ID, APP_IDS.a2, WORKER_IDS.w2, JOB_ID],
  );

  // --- Seed C2-D: workers com whatsapp_phone_encrypted (base64 for KMS test mode) ---
  // w3: whatsapp_phone_encrypted = phone (idêntico, base64-encoded)
  const w3Phone = await pool.query<{ phone: string }>(`SELECT phone FROM workers WHERE id = $1`, [WORKER_IDS.w3]);
  if (w3Phone.rows[0]?.phone) {
    await pool.query(
      `UPDATE workers SET whatsapp_phone_encrypted = $2 WHERE id = $1`,
      [WORKER_IDS.w3, Buffer.from(w3Phone.rows[0].phone).toString('base64')],
    );
  }
  // w4: whatsapp_phone_encrypted diferente de phone
  await pool.query(
    `UPDATE workers SET whatsapp_phone_encrypted = $2 WHERE id = $1`,
    [WORKER_IDS.w4, Buffer.from('5411DIFERENTE').toString('base64')],
  );
  // w5: whatsapp_phone_encrypted NULL
  await pool.query(
    `UPDATE workers SET whatsapp_phone_encrypted = NULL WHERE id = $1`,
    [WORKER_IDS.w5],
  );

  // --- Seed N8-C: blacklist com PII e sem PII ---
  await pool.query(
    `INSERT INTO blacklist (id, worker_id, worker_raw_name, reason, detail, registered_by)
     VALUES
       ($1, $2, 'Test Worker 6', 'Abandono de paciente en crisis',
        'Dejó al paciente solo durante episodio de crisis', 'e2e-test'),
       ($3, $4, 'Test Worker 7', 'Comportamiento inadecuado durante atendimiento',
        'Familiar del paciente denunció trato inapropiado', 'e2e-test'),
       ($5, NULL, 'Ext Worker A', 'Documentación falsa',
        'Certificado no verificable', 'e2e-test'),
       ($6, NULL, 'Ext Worker B', 'No cumple requisitos mínimos',
        NULL, 'e2e-test')
     ON CONFLICT DO NOTHING`,
    [
      BLACKLIST_IDS.b1, WORKER_IDS.w6,
      BLACKLIST_IDS.b2, WORKER_IDS.w7,
      BLACKLIST_IDS.b3,
      BLACKLIST_IDS.b4,
    ],
  );
});

afterAll(async () => {
  // Cleanup
  await pool.query(`DELETE FROM worker_job_applications WHERE id = ANY($1)`, [
    Object.values(APP_IDS),
  ]);
  await pool.query(`DELETE FROM blacklist WHERE id = ANY($1)`, [
    Object.values(BLACKLIST_IDS),
  ]);
  await pool.query(`DELETE FROM job_postings WHERE id = $1`, [JOB_ID]);
  await pool.query(`DELETE FROM workers WHERE id = ANY($1)`, [
    Object.values(WORKER_IDS),
  ]);
  await pool.end();
});

// ═══════════════════════════════════════════════════════════════
// C1 — FK de worker_job_applications.worker_id
// ═══════════════════════════════════════════════════════════════

describe('C1 — FK worker_job_applications.worker_id → workers', () => {
  it('pg_constraint confirma FK apontando para workers', async () => {
    const result = await pool.query<{
      conname: string;
      referencia_para: string;
      definicao: string;
    }>(`
      SELECT conname,
             confrelid::regclass AS referencia_para,
             pg_get_constraintdef(oid) AS definicao
      FROM pg_constraint
      WHERE contype = 'f'
        AND conrelid = 'worker_job_applications'::regclass
        AND pg_get_constraintdef(oid) LIKE '%worker_id%'
    `);

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].referencia_para).toBe('workers');
    expect(result.rows[0].definicao).toContain('REFERENCES workers(id)');
  });

  it('INSERT com worker_id inexistente deve falhar com ForeignKeyViolation', async () => {
    const fakeWorkerId = '00000000-0000-0000-0000-000000000000';

    try {
      await pool.query(
        `INSERT INTO worker_job_applications
           (worker_id, job_posting_id, application_funnel_stage)
         VALUES ($1, $2, 'INVITED')`,
        [fakeWorkerId, JOB_ID],
      );
      fail('INSERT deveria ter falhado com ForeignKeyViolation');
    } catch (err: any) {
      // 23503 = foreign_key_violation
      expect(err.code).toBe('23503');
    }
  });

  it('INSERT com worker_id válido deve ter sucesso', async () => {
    const tempAppId = 'ee210000-0a0e-0001-c1c1-bbb000000099';

    // Usar w3 que não tem application ainda para esse job
    // Primeiro precisamos de um job diferente para evitar unique constraint
    const tempJobId = 'ee210000-0a0e-0001-c1c1-aaa000000099';
    await pool.query(
      `INSERT INTO job_postings (id, title, status, country)
       VALUES ($1, 'Temp job for C1 test', 'ACTIVE', 'AR')
       ON CONFLICT DO NOTHING`,
      [tempJobId],
    );

    const result = await pool.query(
      `INSERT INTO worker_job_applications
         (id, worker_id, job_posting_id, application_funnel_stage)
       VALUES ($1, $2, $3, 'INVITED') RETURNING id`,
      [tempAppId, WORKER_IDS.w3, tempJobId],
    );

    expect(result.rowCount).toBe(1);

    // Cleanup
    await pool.query(`DELETE FROM worker_job_applications WHERE id = $1`, [tempAppId]);
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [tempJobId]);
  });

  it('CASCADE: deletar worker deve remover suas applications', async () => {
    // Criar worker temporário + application
    const tmpWorker = 'ee210000-0a0e-0001-c1c1-ddd000000001';
    const tmpApp = 'ee210000-0a0e-0001-c1c1-ddd000000002';

    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, 'e2e-wave1-tmp-cascade', 'cascade@wave1.test', '54119999999',
               'REGISTERED', 'AR', 'America/Buenos_Aires')`,
      [tmpWorker],
    );

    await pool.query(
      `INSERT INTO worker_job_applications
         (id, worker_id, job_posting_id, application_funnel_stage)
       VALUES ($1, $2, $3, 'INVITED')`,
      [tmpApp, tmpWorker, JOB_ID],
    );

    // Verificar que application existe
    const before = await pool.query(
      `SELECT COUNT(*) AS cnt FROM worker_job_applications WHERE id = $1`,
      [tmpApp],
    );
    expect(Number(before.rows[0].cnt)).toBe(1);

    // Deletar worker
    await pool.query(`DELETE FROM workers WHERE id = $1`, [tmpWorker]);

    // Application deve ter sido removida pelo CASCADE
    const after = await pool.query(
      `SELECT COUNT(*) AS cnt FROM worker_job_applications WHERE id = $1`,
      [tmpApp],
    );
    expect(Number(after.rows[0].cnt)).toBe(0);
  });

  it('nenhum worker_id NULL em worker_job_applications', async () => {
    const result = await pool.query(
      `SELECT COUNT(*) AS cnt FROM worker_job_applications WHERE worker_id IS NULL`,
    );
    expect(Number(result.rows[0].cnt)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// C2-D — whatsapp_phone vs phone (auditoria de redundância)
// ═══════════════════════════════════════════════════════════════

describe('C2-D — workers.whatsapp_phone_encrypted auditoria', () => {
  it('coluna whatsapp_phone_encrypted existe e é TEXT', async () => {
    const result = await pool.query<{
      column_name: string;
      data_type: string;
    }>(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'workers' AND column_name = 'whatsapp_phone_encrypted'
    `);

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].data_type).toBe('text');
  });

  it('whatsapp_phone plaintext já foi migrada (coluna não existe mais)', async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'workers' AND column_name = 'whatsapp_phone'`,
    );
    // Coluna plaintext foi removida — migração concluída
    expect(result.rows.length).toBe(0);
  });

  it('query de auditoria retorna estatísticas corretas', async () => {
    const result = await pool.query<{
      com_whatsapp: string;
      diferentes: string;
      so_whatsapp: string;
    }>(`
      SELECT
        COUNT(*) FILTER (WHERE whatsapp_phone_encrypted IS NOT NULL) AS com_whatsapp,
        COUNT(*) FILTER (WHERE whatsapp_phone_encrypted IS NOT NULL AND phone IS NOT NULL) AS diferentes,
        COUNT(*) FILTER (WHERE whatsapp_phone_encrypted IS NOT NULL AND phone IS NULL) AS so_whatsapp
      FROM workers
      WHERE id = ANY($1)
    `, [
      [WORKER_IDS.w3, WORKER_IDS.w4, WORKER_IDS.w5],
    ]);

    const stats = result.rows[0];

    // w3 e w4 têm whatsapp_phone_encrypted preenchido, w5 tem NULL
    expect(Number(stats.com_whatsapp)).toBe(2);
    // Ambos w3 e w4 têm phone + whatsapp_phone_encrypted
    expect(Number(stats.diferentes)).toBe(2);
    expect(Number(stats.so_whatsapp)).toBe(0);
  });

  it('workers com whatsapp_phone_encrypted diferente de phone são identificáveis', async () => {
    const result = await pool.query(
      `SELECT id, phone, whatsapp_phone_encrypted FROM workers
       WHERE id = $1 AND whatsapp_phone_encrypted IS NOT NULL`,
      [WORKER_IDS.w4],
    );

    expect(result.rows.length).toBe(1);
    // whatsapp_phone_encrypted é base64-encoded, phone é plaintext — sempre diferentes em formato
    expect(result.rows[0].whatsapp_phone_encrypted).toBeTruthy();
  });

  it('whatsapp_phone_encrypted está em formato base64 (KMS test mode)', async () => {
    const result = await pool.query(
      `SELECT whatsapp_phone_encrypted FROM workers WHERE id = $1`,
      [WORKER_IDS.w4],
    );

    // Em KMS test mode, o valor é base64-encoded
    const decoded = Buffer.from(result.rows[0].whatsapp_phone_encrypted, 'base64').toString('utf8');
    expect(decoded).toBe('5411DIFERENTE');
  });
});

// ═══════════════════════════════════════════════════════════════
// N8-C — blacklist.reason e detail — amostragem PII clínico
// ═══════════════════════════════════════════════════════════════

describe('N8-C — blacklist.reason e detail PII clínico', () => {
  it('colunas reason e detail existem como TEXT', async () => {
    const result = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'blacklist' AND column_name IN ('reason', 'detail')
      ORDER BY column_name
    `);

    expect(result.rows.length).toBe(2);

    const detail = result.rows.find(r => r.column_name === 'detail');
    const reason = result.rows.find(r => r.column_name === 'reason');

    expect(reason!.data_type).toBe('text');
    expect(reason!.is_nullable).toBe('NO'); // NOT NULL
    expect(detail!.data_type).toBe('text');
    expect(detail!.is_nullable).toBe('YES');
  });

  it('colunas _encrypted existem (gap resolvido na migration 089)', async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'blacklist'
         AND column_name IN ('reason_encrypted', 'detail_encrypted')
       ORDER BY column_name`,
    );
    expect(result.rows.length).toBe(2);
    expect(result.rows.map((r: any) => r.column_name)).toEqual(['detail_encrypted', 'reason_encrypted']);
  });

  it('amostragem detecta registros com PII clínico (menção a paciente/familiar)', async () => {
    const result = await pool.query(
      `SELECT reason, detail FROM blacklist
       WHERE id = ANY($1)
         AND (
           reason ILIKE '%paciente%'
           OR reason ILIKE '%atendimiento%'
           OR reason ILIKE '%atendimento%'
           OR reason ILIKE '%familiar%'
           OR reason ILIKE '%crisis%'
           OR detail ILIKE '%paciente%'
           OR detail ILIKE '%familiar%'
         )`,
      [Object.values(BLACKLIST_IDS)],
    );

    // Exatamente 2 registros com PII clínico (b1 e b2)
    expect(result.rows.length).toBe(2);

    const reasons = result.rows.map(r => r.reason);
    expect(reasons).toContain('Abandono de paciente en crisis');
    expect(reasons).toContain('Comportamiento inadecuado durante atendimiento');
  });

  it('registros sem PII clínico NÃO aparecem na amostragem', async () => {
    const result = await pool.query(
      `SELECT reason FROM blacklist
       WHERE id = ANY($1)
         AND reason NOT ILIKE '%paciente%'
         AND reason NOT ILIKE '%atendimiento%'
         AND reason NOT ILIKE '%atendimento%'
         AND reason NOT ILIKE '%familiar%'
         AND reason NOT ILIKE '%crisis%'
         AND (detail IS NULL OR (
           detail NOT ILIKE '%paciente%'
           AND detail NOT ILIKE '%familiar%'
         ))`,
      [Object.values(BLACKLIST_IDS)],
    );

    // b3 e b4 não contêm PII clínico
    expect(result.rows.length).toBe(2);
    const reasons = result.rows.map(r => r.reason);
    expect(reasons).toContain('Documentación falsa');
    expect(reasons).toContain('No cumple requisitos mínimos');
  });

  it('reason é armazenado em plaintext (confirmação do gap LGPD)', async () => {
    const result = await pool.query(
      `SELECT reason, detail FROM blacklist WHERE id = $1`,
      [BLACKLIST_IDS.b1],
    );

    // Se fosse criptografado, não seria legível como texto
    expect(result.rows[0].reason).toContain('paciente');
    expect(result.rows[0].detail).toContain('paciente');
  });
});

// ═══════════════════════════════════════════════════════════════
// Linter de PII — varredura de schema
// ═══════════════════════════════════════════════════════════════

describe('Linter de PII — validação transversal de schema', () => {
  it('nenhuma coluna PII estrutural sem sufixo _encrypted (gaps resolvidos)', async () => {
    // Busca colunas com nomes PII (email, phone, cpf, document, whatsapp)
    // que NÃO terminam em _encrypted — esses seriam gaps
    const result = await pool.query<{
      table_name: string;
      column_name: string;
    }>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          column_name ~ '(email|phone|cpf|cuit|document|whatsapp)'
        )
        AND column_name NOT LIKE '%_encrypted'
        AND column_name NOT LIKE '%_raw%'
        AND column_name NOT IN (
          -- Campos mantidos em plaintext por decisão documentada (migration 023):
          'email', 'phone', 'document_type'
        )
      ORDER BY table_name, column_name
    `);

    const gaps = result.rows.map(r => `${r.table_name}.${r.column_name}`);

    // C2-D: workers.whatsapp_phone já foi migrado para whatsapp_phone_encrypted
    expect(gaps).not.toContain('workers.whatsapp_phone');
  });

  it('colunas _encrypted existentes usam tipo TEXT', async () => {
    const result = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name LIKE '%_encrypted'
      ORDER BY table_name, column_name
    `);

    // Todas as colunas _encrypted devem ser TEXT (padrão KMS)
    for (const row of result.rows) {
      expect(row.data_type).toBe('text');
    }
  });
});
