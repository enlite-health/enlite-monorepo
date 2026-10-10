/**
 * admission-049-schema.e2e.test.ts — spec 049, F1: as invariantes das migrations 503-507 provadas no BANCO real
 * (Postgres da stack, migrations aplicadas pelo boot da API). Nada aqui passa pela API: a prova é do banco.
 * Dados SINTÉTICOS (paciente `is_test`, e-mails `@example.test`) — nenhum PII, nenhum clínico.
 *
 * A1-1 claim único · A1-2 claim concorrente (2 transações) · A1-3 trilha append-only · A1-4 documento da reunião
 * A1-5 código ADM · A1-6 re-rodar as 5 migrations · extras: token do Tactiq fora do runtime, células só no Master.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Pool, PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const MASTER_GROUP = 'a0000000-0000-0000-0000-000000000001';
const PATIENT_ID = 'ee049000-c001-4000-8000-000000000001';
const MIGRATIONS = [
  '503_admission_049_appointments_tracking.sql',
  '504_admission_049_messages_events.sql',
  '505_admission_049_tactiq_links.sql',
  '506_admission_049_patient_documents_admission.sql',
  '507_admission_049_cells_and_notification.sql',
];

describe('schema da aba Admissão (spec 049, migrations 503-507)', () => {
  let pool: Pool;
  let seq = 0;

  async function cleanup(): Promise<void> {
    // admission_events é append-only: só sai em cascata quando a reunião-mãe some. Documento admission antes (FK RESTRICT).
    await pool.query(`DELETE FROM patient_documents WHERE patient_id = $1`, [PATIENT_ID]);
    await pool.query(`DELETE FROM admission_appointments WHERE patient_id = $1`, [PATIENT_ID]);
    await pool.query(`DELETE FROM tactiq_links WHERE host_email LIKE '%@example.test'`);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT_ID]);
  }

  async function newAppointment(code: string | null = null): Promise<string> {
    seq += 1;
    const { rows } = await pool.query(
      `INSERT INTO admission_appointments (patient_id, country, host_email, slot_start, slot_end, admission_code)
       VALUES ($1, 'AR', $2, now() + ($3 || ' hours')::interval, now() + ($3 || ' hours')::interval + interval '30 minutes', $4)
       RETURNING id`,
      [PATIENT_ID, `host${seq}@example.test`, String(seq), code],
    );
    return rows[0].id;
  }

  const DOC_INSERT = `INSERT INTO patient_documents
      (patient_id, origin, label_encrypted, file_path_encrypted, original_name_encrypted, content_type, size_bytes, sha256, created_by_uid, source_appointment_id)
    VALUES ($1, $2, 'enc:resumo', 'enc:p', 'enc:n', 'application/pdf', 10, '\\x00', 'e049-staff', $3) RETURNING id`;

  async function sqlState(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (e) {
      return (e as { code?: string }).code ?? 'sem-código';
    }
    return 'NENHUM-ERRO';
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup();
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES ($1, 'e2e-049-schema', 'Paciente', 'Sintetico', 'AR', true)`,
      [PATIENT_ID],
    );
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('0. sanidade: as tabelas e colunas novas existem (o zero das provas abaixo não é banco sem migration)', async () => {
    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM information_schema.tables WHERE table_name IN ('admission_messages','admission_events','tactiq_links'))::int AS tabelas,
              (SELECT count(*) FROM information_schema.columns WHERE table_name='admission_appointments' AND column_name IN
                ('admission_code','created_via','created_by_uid','cancelled_at','cancelled_by_uid','meet_space_name','conference_ended_at','import_status','import_attempts'))::int AS colunas_appt,
              (SELECT count(*) FROM information_schema.columns WHERE table_name='patient_documents' AND column_name='source_appointment_id')::int AS coluna_doc`,
    );
    expect(rows[0]).toEqual({ tabelas: 3, colunas_appt: 9, coluna_doc: 1 });
  });

  it('A1-1. 2º INSERT em admission_messages com o mesmo (appointment_id, kind, attempt) → 23505', async () => {
    const appt = await newAppointment();
    const ins = `INSERT INTO admission_messages (appointment_id, kind, attempt) VALUES ($1, 'confirmation', 0)`;
    await pool.query(ins, [appt]);
    expect(await sqlState(() => pool.query(ins, [appt]))).toBe('23505');
    // outra tentativa e outro kind são claims distintos
    await pool.query(`INSERT INTO admission_messages (appointment_id, kind, attempt) VALUES ($1, 'confirmation', 1)`, [appt]);
    await pool.query(`INSERT INTO admission_messages (appointment_id, kind, attempt) VALUES ($1, 'reminder_30min', 0)`, [appt]);
    expect(await sqlState(() => pool.query(`INSERT INTO admission_messages (appointment_id, kind, attempt) VALUES ($1, 'confirmation', 3)`, [appt]))).toBe('23514');
  });

  it('A1-2. duas transações abertas fazendo INSERT … ON CONFLICT DO NOTHING RETURNING no mesmo claim → exatamente 1 linha devolvida', async () => {
    const appt = await newAppointment();
    const claim = `INSERT INTO admission_messages (appointment_id, kind, attempt) VALUES ($1, 'reminder_30min', 0)
                   ON CONFLICT (appointment_id, kind, attempt) DO NOTHING RETURNING id`;
    const c1: PoolClient = await pool.connect();
    const c2: PoolClient = await pool.connect();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      const first = await c1.query(claim, [appt]); // ganha o claim, transação ainda ABERTA
      const second = c2.query(claim, [appt]); // bloqueia esperando c1 — a corrida real
      await new Promise((r) => setTimeout(r, 300));
      await c1.query('COMMIT');
      const secondRes = await second;
      await c2.query('COMMIT');
      expect(first.rows).toHaveLength(1);
      expect(secondRes.rows).toHaveLength(0);
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM admission_messages WHERE appointment_id = $1 AND kind = 'reminder_30min'`, [appt]);
      expect(rows[0].n).toBe(1);
    } finally {
      await c1.query('ROLLBACK').catch(() => undefined);
      await c2.query('ROLLBACK').catch(() => undefined);
      c1.release();
      c2.release();
    }
  });

  it('A1-3. UPDATE e DELETE em admission_events → erro do trigger; a linha não muda; some só em cascata com a reunião', async () => {
    const appt = await newAppointment();
    const { rows } = await pool.query(
      `INSERT INTO admission_events (appointment_id, kind, outcome) VALUES ($1, 'booked', 'ok') RETURNING id`, [appt]);
    const id = rows[0].id;
    await expect(pool.query(`UPDATE admission_events SET outcome = 'adulterado' WHERE id = $1`, [id])).rejects.toThrow(/admission_events_imutavel/);
    await expect(pool.query(`DELETE FROM admission_events WHERE id = $1`, [id])).rejects.toThrow(/admission_events_imutavel/);
    expect((await pool.query(`SELECT outcome FROM admission_events WHERE id = $1`, [id])).rows).toEqual([{ outcome: 'ok' }]);
    // evento de vínculo (sem reunião) também não se apaga
    const link = await pool.query(
      `INSERT INTO admission_events (host_email, kind) VALUES ('a@example.test', 'tactiq_link.notified') RETURNING id`);
    await expect(pool.query(`DELETE FROM admission_events WHERE id = $1`, [link.rows[0].id])).rejects.toThrow(/admission_events_imutavel/);
    // sem reunião, só `tactiq_link.*` com e-mail
    expect(await sqlState(() => pool.query(`INSERT INTO admission_events (kind) VALUES ('booked')`))).toBe('23514');
    // a cascata da reunião-mãe leva a trilha dela (é o que o purge de paciente de teste faz)
    await pool.query(`DELETE FROM admission_appointments WHERE id = $1`, [appt]);
    expect((await pool.query(`SELECT 1 FROM admission_events WHERE id = $1`, [id])).rowCount).toBe(0);
  });

  it('A1-4. 2º documento com o mesmo source_appointment_id → 23505; documento admission sem source_appointment_id → 23514', async () => {
    const appt = await newAppointment();
    await pool.query(DOC_INSERT, [PATIENT_ID, 'admission', appt]);
    expect(await sqlState(() => pool.query(DOC_INSERT, [PATIENT_ID, 'admission', appt]))).toBe('23505');
    expect(await sqlState(() => pool.query(DOC_INSERT, [PATIENT_ID, 'admission', null]))).toBe('23514');
    // a origem tab continua sem source_appointment_id
    expect(await sqlState(() => pool.query(DOC_INSERT, [PATIENT_ID, 'tab', appt]))).toBe('23514');
    await pool.query(DOC_INSERT, [PATIENT_ID, 'tab', null]);
    // FK RESTRICT: a reunião com documento não se apaga (e não vira um 23514 confuso)
    expect(await sqlState(() => pool.query(`DELETE FROM admission_appointments WHERE id = $1`, [appt]))).toBe('23503');
  });

  it('A1-5. admission_code duplicado → 23505; formato inválido → 23514; NULL repetido é livre (reuniões antigas)', async () => {
    await newAppointment('ADM-7K2Q9X');
    expect(await sqlState(() => newAppointment('ADM-7K2Q9X'))).toBe('23505');
    for (const ruim of ['ADM-abc123', 'ADM-12345', 'XXX-123456', 'ADM-1234567']) {
      expect(await sqlState(() => newAppointment(ruim))).toBe('23514');
    }
    await newAppointment(null);
    await newAppointment(null);
  });

  it('A1-6. re-rodar as 5 migrations no mesmo banco (boot depois de aplicação manual) → sem erro e sem duplicar célula', async () => {
    const cellsBefore = (await pool.query(`SELECT count(*)::int AS n FROM iam.permissions WHERE resource IN ('patient_admission','own_tactiq_link')`)).rows[0].n;
    for (const file of MIGRATIONS) {
      const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', file), 'utf8');
      await expect(pool.query(sql)).resolves.toBeDefined();
    }
    const cellsAfter = (await pool.query(`SELECT count(*)::int AS n FROM iam.permissions WHERE resource IN ('patient_admission','own_tactiq_link')`)).rows[0].n;
    expect(cellsBefore).toBeGreaterThanOrEqual(5);
    expect(cellsAfter).toBe(cellsBefore);
  });

  it('A1-8. células: as 4 patient_admission:* no Acesso Master e (H7) no grupo EXATO "Admisión y Supervisión" quando existe — em nenhum outro; as 2 own_tactiq_link:* no catálogo; tipo de notificação semeado', async () => {
    const { rows: cells } = await pool.query(
      `SELECT p.resource || ':' || p.action AS cell FROM iam.permissions p
        WHERE p.resource IN ('patient_admission','own_tactiq_link') AND p.deprecated_at IS NULL ORDER BY 1`);
    expect(cells.map((c) => c.cell)).toEqual([
      'own_tactiq_link:create', 'own_tactiq_link:read',
      'patient_admission:create', 'patient_admission:read', 'patient_admission:resend_message', 'patient_admission:update',
    ]);
    const gruposComCelulas = async (): Promise<Array<{ group_id: string; n: number }>> => (await pool.query(
      `SELECT gp.group_id, count(*)::int AS n FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id
        WHERE p.resource = 'patient_admission' GROUP BY gp.group_id`)).rows;

    // Sem o grupo (stage): só o Master, com as 4.
    const { rows: tenant } = await pool.query(`SELECT tenant_id FROM iam.permission_groups WHERE id = $1`, [MASTER_GROUP]);
    const nomeAdmissao = 'Admisión y Supervisión';
    const jaExiste = (await pool.query(`SELECT 1 FROM iam.permission_groups WHERE name = $1`, [nomeAdmissao])).rowCount;
    const antes = await gruposComCelulas();
    if (!jaExiste) expect(antes).toEqual([{ group_id: MASTER_GROUP, n: 4 }]);

    // Caminho positivo: cria o grupo de nome EXATO + um controle de outro nome, reaplica a 507 → só o EXATO ganha as 4.
    const criados: string[] = [];
    try {
      if (!jaExiste) {
        const g = await pool.query(`INSERT INTO iam.permission_groups (tenant_id, name, description) VALUES ($1, $2, 'e2e 049 A1-8') RETURNING id`, [tenant[0].tenant_id, nomeAdmissao]);
        criados.push(g.rows[0].id);
      }
      const c = await pool.query(`INSERT INTO iam.permission_groups (tenant_id, name, description) VALUES ($1, 'e2e049 Outro Grupo', 'controle') RETURNING id`, [tenant[0].tenant_id]);
      criados.push(c.rows[0].id);
      const controleId = c.rows[0].id as string;

      const sql507 = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', MIGRATIONS[4]), 'utf8');
      await expect(pool.query(sql507)).resolves.toBeDefined();

      const { rows: admRows } = await pool.query(`SELECT id FROM iam.permission_groups WHERE name = $1 AND archived_at IS NULL`, [nomeAdmissao]);
      expect(admRows.length).toBeGreaterThan(0);
      const depois = await gruposComCelulas();
      const ids = depois.map((r) => r.group_id).sort();
      expect(ids).toEqual([MASTER_GROUP, ...admRows.map((r) => r.id as string)].sort());
      expect(depois.every((r) => r.n === 4)).toBe(true);
      expect(ids).not.toContain(controleId);
    } finally {
      for (const id of criados) {
        await pool.query(`DELETE FROM iam.group_permissions WHERE group_id = $1`, [id]);
        await pool.query(`DELETE FROM iam.permission_groups WHERE id = $1`, [id]);
      }
    }
    const { rows: nt } = await pool.query(`SELECT 1 FROM notification_types WHERE code = 'ADMISSION_TACTIQ_LINK_REQUIRED'`);
    expect(nt).toHaveLength(1);
  });

  // A convenção own_ (471) concede `own_tactiq_link:*` a TODO grupo ativo pelo SYNC do catálogo no boot da API — e o banco do
  // job `backend-e2e` nunca roda o sync (`PERMISSION_CATALOG_SYNC_ENABLED` só existe no deploy; ligá-lo ali descontinuaria
  // células que `permissions-iam-schema` ainda espera). SKIP DECLARADO, não verde-sem-medir: com `E2E_ABAC_STACK=1` (a stack
  // do job `integration-e2e-group-simulation` do `_frontend-integration.yml`, engine ligado + sync + ADMISSION_EXTERNALS=fake)
  // este caso RODA — o mesmo passo roda os blocos `E2E_ABAC_STACK` dos outros e2e da 049.
  const comSync = process.env.E2E_ABAC_STACK === '1' ? it : it.skip;
  comSync('A1-8b. (stack com sync do catálogo) own_tactiq_link:* segue a convenção own_ (471): TODO grupo ativo tem as duas células', async () => {
    const { rows: own } = await pool.query(
      `SELECT g.id, count(DISTINCT p.action)::int AS n
         FROM iam.permission_groups g
         LEFT JOIN iam.group_permissions gp ON gp.group_id = g.id
         LEFT JOIN iam.permissions p ON p.id = gp.permission_id AND p.resource = 'own_tactiq_link' AND p.deprecated_at IS NULL
        WHERE g.archived_at IS NULL GROUP BY g.id`);
    expect(own.length).toBeGreaterThan(0); // contagem zero não é sucesso
    expect(own.filter((r) => r.n !== 2)).toEqual([]);
  });

  it('A1-9. o token cifrado do Tactiq (tabela à parte, RLS só do sistema) é invisível ao app_runtime — 0 linhas, escrita 42501 — mas o estado do vínculo ele lê; e-mail é único sem olhar caixa', async () => {
    const { rows: ins } = await pool.query(
      `INSERT INTO tactiq_links (host_email, firebase_uid, status) VALUES ('Op1@example.test', 'e049-op1', 'linked') RETURNING id`);
    await pool.query(`INSERT INTO tactiq_link_secrets (link_id, refresh_token_encrypted) VALUES ($1, 'enc:segredo')`, [ins[0].id]);
    expect(await sqlState(() => pool.query(
      `INSERT INTO tactiq_links (host_email, firebase_uid, status) VALUES ('op1@EXAMPLE.test', 'e049-op1b', 'linked')`))).toBe('23505');
    // o segredo exige o vínculo (FK) e some com ele (CASCADE)
    expect(await sqlState(() => pool.query(
      `INSERT INTO tactiq_link_secrets (link_id, refresh_token_encrypted) VALUES (gen_random_uuid(), 'enc:x')`))).toBe('23503');

    const lerSegredos = async (role: string | null): Promise<number> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        if (role) await client.query(`SET LOCAL ROLE ${role}`);
        const r = await client.query(`SELECT refresh_token_encrypted FROM tactiq_link_secrets WHERE link_id = $1`, [ins[0].id]);
        return r.rows.length;
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };
    // controle positivo: o dono e o app_system VEEM a linha (senão "0 linhas" do runtime não provaria nada)
    expect(await lerSegredos(null)).toBe(1);
    expect(await lerSegredos('app_system')).toBe(1);
    expect(await lerSegredos('app_runtime')).toBe(0);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_runtime');
      const ok = await client.query(`SELECT * FROM tactiq_links WHERE lower(host_email) = 'op1@example.test'`);
      expect(ok.rows).toHaveLength(1);
      expect(ok.rows[0]).not.toHaveProperty('refresh_token_encrypted');
      await client.query('SAVEPOINT s');
      expect(await sqlState(() => client.query(
        `INSERT INTO tactiq_link_secrets (link_id, refresh_token_encrypted) VALUES ($1, 'enc:runtime')`, [ins[0].id]))).toBe('42501');
      await client.query('ROLLBACK TO SAVEPOINT s');
      expect(await sqlState(() => client.query(`UPDATE tactiq_link_secrets SET refresh_token_encrypted = 'x'`))).toBe('42501');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
