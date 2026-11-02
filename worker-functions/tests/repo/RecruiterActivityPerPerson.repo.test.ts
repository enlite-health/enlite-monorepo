/**
 * RecruiterActivityPerPerson.repo.test.ts — Postgres REAL (nunca mock), spec 081 / T064b / D602a.
 * Banco EFÊMERO próprio (CREATE DATABASE) com SÓ as quatro tabelas que a consulta lê (mesmos nomes e tipos das
 * migrations 079, 169 e 202; sem FKs); derruba no afterAll. Como rodar (protocolo dos irmãos de tests/repo):
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:5595/enlite_e2e \
 *     npx jest --config jest.config.repo.js RecruiterActivityPerPerson --maxWorkers=2
 *
 * FIXTURE SINTÉTICA — relógio fixo `NOW` = 2026-11-04T15:00:00Z (quarta). Semana = segunda-feira em Buenos Aires (-03).
 * weeks=2 => janela desde segunda 2026-10-26 00:00 BA (= 03:00Z). Atores: staff A, staff B, Luz, sistema,
 * staff com e-mail no lugar do uid, pseudo-ator admin_panel, prestador (worker_self) e linha sem autor.
 *
 * NÚMEROS ESPERADOS (exatos), ordem semana DESC e uid ASC:
 *   2026-11-02 · A: funil 1, status 0, perfil 1, total 2, prestadores 2   (o funil de A cai 00:30 BA de segunda; em UTC já seria segunda também)
 *   2026-11-02 · B: funil 0, status 2, perfil 0, total 2, prestadores 1
 *   2026-10-26 · A: funil 2, status 1, perfil 0, total 3, prestadores 2
 *   2026-10-26 · B: funil 1, status 1, perfil 0, total 2, prestadores 1   (o status de B cai domingo 23:30 BA = segunda 02:30Z: semana BA, não UTC)
 * FORA: A às 2026-10-26T02:30Z (domingo 23:30 BA, semana de 10-19) e A em 10-25; B depois do relógio (11-05).
 */
import { Pool } from 'pg';
import { GetRecruiterActivityPerPersonUseCase } from '../../src/modules/matching/application/GetRecruiterActivityPerPersonUseCase';

const BASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@127.0.0.1:5595/enlite_e2e';
const NOW = new Date('2026-11-04T15:00:00Z');
const W1 = '00000000-0000-4000-8000-000000000001';
const W2 = '00000000-0000-4000-8000-000000000002';
const W3 = '00000000-0000-4000-8000-000000000003';
const A = 'uid-sintetico-A';
const B = 'uid-sintetico-B';

let pool: Pool;
let dbName: string;
let appSeq = 0;

async function funil(changedBy: string | null, workerId: string, ts: string): Promise<void> {
  appSeq += 1;
  const id = `10000000-0000-4000-8000-${String(appSeq).padStart(12, '0')}`;
  await pool.query(`INSERT INTO worker_job_applications (id, worker_id) VALUES ($1,$2)`, [id, workerId]);
  await pool.query(
    `INSERT INTO worker_job_application_stage_history (application_id, field_name, new_value, changed_by, created_at)
     VALUES ($1,'stage','x',$2,$3)`,
    [id, changedBy, ts],
  );
}
const status = (changedBy: string | null, workerId: string, ts: string) =>
  pool.query(`INSERT INTO worker_status_history (worker_id, field_name, new_value, changed_by, created_at) VALUES ($1,'status','x',$2,$3)`, [workerId, changedBy, ts]);
const perfil = (changedBy: string, workerId: string, ts: string) =>
  pool.query(`INSERT INTO worker_profile_changes_audit (worker_id, field_name, changed_by, created_at) VALUES ($1,'campo',$2,$3)`, [workerId, changedBy, ts]);

async function seed(): Promise<void> {
  // semana 10-26
  await funil(`staff:${A}`, W1, '2026-10-28T15:00:00Z');
  await funil(`staff:${A}`, W2, '2026-10-28T16:00:00Z');
  await status(`staff:${A}`, W1, '2026-10-29T15:00:00Z');
  await funil(`staff:${B}`, W3, '2026-10-28T17:00:00Z');
  await status(`staff:${B}`, W3, '2026-11-02T02:30:00Z'); // domingo 23:30 em BA
  // semana 11-02
  await funil(`staff:${A}`, W1, '2026-11-02T03:30:00Z'); // segunda 00:30 em BA
  await perfil(`staff:${A}`, W2, '2026-11-03T15:00:00Z');
  await status(`staff:${B}`, W1, '2026-11-03T15:00:00Z');
  await status(`staff:${B}`, W1, '2026-11-03T16:00:00Z');
  // fora da janela / do relógio
  await funil(`staff:${A}`, W3, '2026-10-26T02:30:00Z'); // domingo 23:30 BA, semana de 10-19
  await funil(`staff:${A}`, W3, '2026-10-25T20:00:00Z');
  await funil(`staff:${B}`, W3, '2026-11-05T00:00:00Z'); // depois do NOW
  // atores que NÃO são staff:<uid>
  for (let i = 0; i < 5; i += 1) await funil('luz:apply', W1, '2026-10-28T15:00:00Z');
  for (let i = 0; i < 3; i += 1) await status('system:scheduler', W2, '2026-11-03T15:00:00Z');
  await funil('staff:alguem@exemplo.test', W2, '2026-11-03T15:00:00Z'); // e-mail no lugar do uid
  await perfil('admin_panel', W2, '2026-11-03T15:00:00Z'); // trilha de cadastro não grava uid
  await status('worker_self:abc', W2, '2026-11-03T15:00:00Z');
  await status(null, W2, '2026-11-03T15:00:00Z');
}

beforeAll(async () => {
  dbName = `t064b_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Pool({ connectionString: BASE_URL });
  try { await admin.query(`CREATE DATABASE ${dbName}`); } finally { await admin.end(); }
  const u = new URL(BASE_URL);
  u.pathname = `/${dbName}`;
  pool = new Pool({ connectionString: u.toString() });
  await pool.query(`
    CREATE TABLE worker_job_applications (id UUID PRIMARY KEY, worker_id UUID NOT NULL);
    CREATE TABLE worker_job_application_stage_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), application_id UUID NOT NULL,
      field_name VARCHAR(50) NOT NULL, old_value VARCHAR(50), new_value VARCHAR(50) NOT NULL,
      changed_by VARCHAR(128), change_source VARCHAR(100), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE worker_status_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), worker_id UUID NOT NULL,
      field_name VARCHAR(50) NOT NULL, old_value VARCHAR(50), new_value VARCHAR(50) NOT NULL,
      changed_by VARCHAR(128), change_source VARCHAR(100), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE worker_profile_changes_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), worker_id UUID NOT NULL, pending_change_id UUID,
      field_name VARCHAR(60) NOT NULL, changed_by VARCHAR(40) NOT NULL DEFAULT 'luz',
      source VARCHAR(40) NOT NULL DEFAULT 'triage', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  `);
  await seed();
});

afterAll(async () => {
  await pool.end();
  const admin = new Pool({ connectionString: BASE_URL });
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  } finally { await admin.end(); }
});

const row = (staffUid: string, weekStart: string, funnelMoves: number, statusChanges: number, profileEdits: number, workers: number) => ({
  staffUid, weekStart, funnelMoves, statusChanges, profileEdits, totalActions: funnelMoves + statusChanges + profileEdits, workers,
});

describe('GetRecruiterActivityPerPersonUseCase — 2 staff, Luz, sistema e ruído, em 2 semanas', () => {
  it('números exatos por (staff, semana BA); Luz, sistema, e-mail e trilha sem uid NÃO aparecem', async () => {
    const r = await new GetRecruiterActivityPerPersonUseCase(pool).execute({ weeks: 2, now: NOW });
    expect(r.weeks).toBe(2);
    expect(r.rows).toEqual([
      row(A, '2026-11-02', 1, 0, 1, 2),
      row(B, '2026-11-02', 0, 2, 0, 1),
      row(A, '2026-10-26', 2, 1, 0, 2),
      row(B, '2026-10-26', 1, 1, 0, 1),
    ]);
  });

  it('nenhum campo de e-mail, nome, rótulo, worker_id ou identidade crua sai; nada de Luz/sistema', async () => {
    const r = await new GetRecruiterActivityPerPersonUseCase(pool).execute({ weeks: 2, now: NOW });
    const permitidas = ['staffUid', 'weekStart', 'funnelMoves', 'statusChanges', 'profileEdits', 'totalActions', 'workers'].sort();
    for (const linha of r.rows) expect(Object.keys(linha).sort()).toEqual(permitidas);
    const texto = JSON.stringify(r);
    for (const proibido of ['@', 'exemplo.test', 'luz', 'system', 'scheduler', 'admin_panel', 'worker_self', 'staff:', W1, W2, W3]) {
      expect(texto).not.toContain(proibido);
    }
  });

  it('weeks=1 devolve só a semana corrente (2026-11-02)', async () => {
    const r = await new GetRecruiterActivityPerPersonUseCase(pool).execute({ weeks: 1, now: NOW });
    expect(r.rows).toEqual([row(A, '2026-11-02', 1, 0, 1, 2), row(B, '2026-11-02', 0, 2, 0, 1)]);
  });

  it('weeks=3 puxa a semana de 10-19 (os dois eventos de A fora da janela de 2 semanas)', async () => {
    const r = await new GetRecruiterActivityPerPersonUseCase(pool).execute({ weeks: 3, now: NOW });
    expect(r.rows.filter((x) => x.weekStart === '2026-10-19')).toEqual([row(A, '2026-10-19', 2, 0, 0, 1)]);
  });
});
