/**
 * confirmed-052-migration.e2e.test.ts — spec 052, Fase 4 (T-39): a migration 520 contra POSTGRES REAL.
 *
 * Executa o SQL do arquivo `migrations/520_confirmed_stage_to_completed.sql` (lido do disco, uma transação por execução, como o
 * runner) sobre dado semeado com o `CHECK` do estágio ainda aberto. Nada toca canal real; dados SINTÉTICOS ("Ficticio NN",
 * e-mails `@example.test`); nenhum nome, telefone ou e-mail entra em asserção ou log.
 *
 * O que cada caso mata (sabotagem → vermelho):
 *   A guarda final falha alto  → tirar a guarda final da 520 (linha deixada no estágio não faz a migration falhar)
 *   B move, ator, bypass       → tirar o bypass do trigger (aborta na linha manual + worker INCOMPLETE_REGISTER) · tirar o ator
 *                               (`changed_by` ≠ 'system:migration-520') · fazer a 520 emitir evento / enfileirar mensagem
 *                               (contagens de `domain_events` e `messaging_outbox` mudam)
 *   C re-rodável               → a segunda execução criaria histórico novo
 */
import { Pool, PoolClient } from 'pg';
import fs from 'fs';
import path from 'path';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const MIGRATION_SQL = path.join(__dirname, '..', '..', 'migrations', '520_confirmed_stage_to_completed.sql');
const ATOR = 'system:migration-520';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const INTERVIEW_AT = '2026-11-20T13:00:00.000Z';
const MEET_LINK = 'https://meet.example.test/aaa-bbbb-ccc';

describe('migration 520 — Confirmado vira Completado (spec 052, Fase 4)', () => {
  let admin: Pool;
  let patientId: string;
  let vacancyId: string;
  const workerIds: string[] = [];
  let wjaTalentum: string; // talentum + worker REGISTERED, com data, link e resposta
  let wjaManual: string; // manual + worker INCOMPLETE_REGISTER (o bypass do trigger é o que a deixa passar)
  let wjaControle: string; // SELECTED: não pode ser tocada
  let workerTalentum: string;
  let outboxConvite: string; // qualified_worker_request pending: cancelada
  let outboxConviteEnviado: string; // qualified_worker_request sent: intacta
  let outboxOutroSlug: string; // outro template pending: intacta

  const sql = () => fs.readFileSync(MIGRATION_SQL, 'utf8');

  /** Uma execução = uma transação, como o runner (`BEGIN; <arquivo>; COMMIT`), numa conexão própria. */
  async function executarMigration(): Promise<void> {
    const client: PoolClient = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql());
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const count = async (q: string, params: unknown[] = []): Promise<number> =>
    Number((await admin.query(q, params)).rows[0].n);
  const totalEventos = () => count('SELECT COUNT(*)::int AS n FROM domain_events');
  const totalOutbox = () => count('SELECT COUNT(*)::int AS n FROM messaging_outbox');
  const historicoDe = (id: string) =>
    admin.query(
      `SELECT old_value, new_value, changed_by, reason_category FROM worker_job_application_stage_history
       WHERE application_id = $1 AND field_name = 'application_funnel_stage' ORDER BY created_at, id`,
      [id],
    );
  const estagio = async (id: string) =>
    (await admin.query('SELECT application_funnel_stage AS s FROM worker_job_applications WHERE id = $1', [id])).rows[0].s;

  async function novoWorker(status: 'REGISTERED' | 'INCOMPLETE_REGISTER', n: number): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO workers (auth_uid, email, country, timezone, status, first_name_encrypted, last_name_encrypted)
       VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires', $3, 'cipher', 'cipher') RETURNING id`,
      [`c520-${RUN}-${n}`, `worker${n}.c520.${RUN}@example.test`, status],
    );
    workerIds.push(rows[0].id);
    return rows[0].id as string;
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    const pat = await admin.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test) VALUES ($1, 'Ficticia', 'Cinco', 'AR', true) RETURNING id`,
      [`c520-${RUN}`],
    );
    patientId = pat.rows[0].id;
    const vac = await admin.query(
      `INSERT INTO job_postings (title, patient_id, status, is_draft, country, is_test, case_number)
       VALUES ($1, $2, 'SEARCHING', false, 'AR', true, $3) RETURNING id`,
      [`C520 ${RUN}`, patientId, 800000 + Math.floor(Math.random() * 90000)],
    );
    vacancyId = vac.rows[0].id;

    workerTalentum = await novoWorker('REGISTERED', 1);
    const workerManual = await novoWorker('INCOMPLETE_REGISTER', 2);
    const workerControle = await novoWorker('REGISTERED', 3);

    // Semeia com o CHECK ainda aberto (CONFIRMED vale). O bypass vale SÓ nesta transação de semeadura: a execução da 520
    // abre outra e precisa trazer o próprio bypass.
    const seed = await admin.connect();
    try {
      await seed.query('BEGIN');
      await seed.query("SELECT set_config('app.bypass_registered_guard', 'on', true)");
      const ins = async (worker: string, stage: string, source: string, extra = false): Promise<string> =>
        (
          await seed.query(
            extra
              ? `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source, interview_datetime, interview_meet_link, interview_response)
                 VALUES ($1, $2, $3, $4, $5, $6, 'confirmed') RETURNING id`
              : `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ($1, $2, $3, $4) RETURNING id`,
            extra ? [worker, vacancyId, stage, source, INTERVIEW_AT, MEET_LINK] : [worker, vacancyId, stage, source],
          )
        ).rows[0].id;
      wjaTalentum = await ins(workerTalentum, 'CONFIRMED', 'talentum', true);
      wjaManual = await ins(workerManual, 'CONFIRMED', 'manual');
      wjaControle = await ins(workerControle, 'SELECTED', 'manual');
      await seed.query('COMMIT');
    } catch (err) {
      await seed.query('ROLLBACK');
      throw err;
    } finally {
      seed.release();
    }

    const out = await admin.query(
      `INSERT INTO messaging_outbox (worker_id, template_slug, variables, status, attempts) VALUES
         ($1, 'qualified_worker_request', '{}', 'pending', 0),
         ($1, 'qualified_worker_request', '{}', 'sent', 1),
         ($1, 'qualified_worker_response', '{}', 'pending', 0) RETURNING id`,
      [workerTalentum],
    );
    [outboxConvite, outboxConviteEnviado, outboxOutroSlug] = out.rows.map((r) => r.id as string);
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.query('DROP TRIGGER IF EXISTS a_tmp520_pular ON worker_job_applications').catch(() => undefined);
    await admin.query('DROP FUNCTION IF EXISTS tmp520_pular()').catch(() => undefined);
    await admin.query('DELETE FROM messaging_outbox WHERE worker_id = ANY($1)', [workerIds]).catch(() => undefined);
    await admin.query('DELETE FROM worker_job_applications WHERE job_posting_id = $1', [vacancyId]).catch(() => undefined);
    await admin.query('DELETE FROM workers WHERE id = ANY($1)', [workerIds]).catch(() => undefined);
    await admin.query('DELETE FROM job_postings WHERE id = $1', [vacancyId]).catch(() => undefined);
    await admin.query('DELETE FROM patients WHERE id = $1', [patientId]).catch(() => undefined);
    await admin.end();
  });

  it('A. a guarda final falha ALTO: uma linha que não saiu do estágio derruba a migration inteira (e nada é gravado)', async () => {
    // Controle positivo do semeado: as duas linhas estão no estágio ANTES de qualquer execução.
    expect(await estagio(wjaTalentum)).toBe('CONFIRMED');
    expect(await estagio(wjaManual)).toBe('CONFIRMED');

    // Trigger BEFORE UPDATE que descarta o UPDATE de UMA linha (retorna NULL): ela fica em CONFIRMED mesmo com o UPDATE da 520.
    await admin.query(`
      CREATE OR REPLACE FUNCTION tmp520_pular() RETURNS trigger AS $$
      BEGIN IF OLD.id = '${wjaManual}'::uuid THEN RETURN NULL; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await admin.query('CREATE TRIGGER a_tmp520_pular BEFORE UPDATE ON worker_job_applications FOR EACH ROW EXECUTE FUNCTION tmp520_pular()');
    try {
      await expect(executarMigration()).rejects.toThrow(/520 falhou/);
    } finally {
      await admin.query('DROP TRIGGER IF EXISTS a_tmp520_pular ON worker_job_applications');
      await admin.query('DROP FUNCTION IF EXISTS tmp520_pular()');
    }
    // A transação inteira foi desfeita: a outra candidatura e a fila seguem como estavam.
    expect(await estagio(wjaTalentum)).toBe('CONFIRMED');
    expect(await estagio(wjaManual)).toBe('CONFIRMED');
    expect((await admin.query('SELECT status FROM messaging_outbox WHERE id = $1', [outboxConvite])).rows[0].status).toBe('pending');
  });

  it('B. move as duas para COMPLETED com o ator da migration, sem tocar em interview_*, em eventos nem na fila nova', async () => {
    const eventosAntes = await totalEventos();
    const outboxAntes = await totalOutbox();
    const historicoControleAntes = (await historicoDe(wjaControle)).rows.length;

    await executarMigration();

    // 0 no estágio (escopo: a vaga semeada) e as duas em COMPLETED; a de controle em SELECTED.
    expect(await count(`SELECT COUNT(*)::int AS n FROM worker_job_applications WHERE job_posting_id = $1 AND application_funnel_stage = 'CONFIRMED'`, [vacancyId])).toBe(0);
    expect(await estagio(wjaTalentum)).toBe('COMPLETED');
    expect(await estagio(wjaManual)).toBe('COMPLETED');
    expect(await estagio(wjaControle)).toBe('SELECTED');

    // interview_* iguais.
    const wja = (await admin.query('SELECT interview_datetime, interview_meet_link, interview_response FROM worker_job_applications WHERE id = $1', [wjaTalentum])).rows[0];
    expect(new Date(wja.interview_datetime).toISOString()).toBe(INTERVIEW_AT);
    expect(wja.interview_meet_link).toBe(MEET_LINK);
    expect(wja.interview_response).toBe('confirmed');

    // Histórico: a linha do INSERT (CONFIRMED) + UMA nova CONFIRMED → COMPLETED com o ator e sem reason_category.
    for (const id of [wjaTalentum, wjaManual]) {
      const h = (await historicoDe(id)).rows;
      const novas = h.filter((r) => r.old_value === 'CONFIRMED' && r.new_value === 'COMPLETED');
      expect(novas).toHaveLength(1);
      expect(novas[0].changed_by).toBe(ATOR);
      expect(novas[0].reason_category).toBeNull();
    }
    expect((await historicoDe(wjaControle)).rows.length).toBe(historicoControleAntes);

    // Nenhum evento e nenhuma mensagem NOVA: as contagens totais não mexem.
    expect(await totalEventos()).toBe(eventosAntes);
    expect(await totalOutbox()).toBe(outboxAntes);

    // Fila: só o convite pending foi cancelado, com o motivo; o enviado e o outro template ficam como estavam.
    const fila = async (id: string) => (await admin.query('SELECT status, error FROM messaging_outbox WHERE id = $1', [id])).rows[0];
    const convite = await fila(outboxConvite);
    expect(convite.status).toBe('failed');
    expect(convite.error).toMatch(/cancelled by migration 520/);
    expect((await fila(outboxConviteEnviado)).status).toBe('sent');
    expect((await fila(outboxOutroSlug)).status).toBe('pending');
  });

  it('C. re-rodável: a segunda execução não cria histórico, não mexe na fila e não falha', async () => {
    const historicoAntes = (await historicoDe(wjaTalentum)).rows.length + (await historicoDe(wjaManual)).rows.length;
    const outboxAntes = await totalOutbox();

    await executarMigration();

    expect((await historicoDe(wjaTalentum)).rows.length + (await historicoDe(wjaManual)).rows.length).toBe(historicoAntes);
    expect(await totalOutbox()).toBe(outboxAntes);
    expect(await estagio(wjaTalentum)).toBe('COMPLETED');
    expect(await estagio(wjaManual)).toBe('COMPLETED');
  });
});
