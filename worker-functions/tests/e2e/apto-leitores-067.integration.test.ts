/**
 * apto-leitores-067.integration.test.ts — spec 067 F3 (FR-06/08/12), banco REAL.
 *
 * Os unit da F3 provam que cada leitor passa o apto à derivação; este arquivo prova que o SQL que eles emitem
 * (coluna `worker_apto` via fn_worker_is_apto, GROUP BY posicional, UNION ALL) EXECUTA e dá a MESMA resposta nos
 * cinco leitores: Kanban da vaga (C1), tabela do funil (C2), contadores da lista de vagas (C3), Gestão à Vista (C4)
 * e ficha do prestador (C5).
 *
 * Massa: 1 vaga viva; 3 prestadores REGISTERED com cadastro completo —
 *   apto      : documentos obrigatórios validados      → QUALIFIED  → COMPLETED
 *   naoApto   : documentos enviados, SEM validação     → QUALIFIED  → BLOQUEADO
 *   semDoc    : sem worker_documents (REGISTERED legado) → IN_DOUBT → BLOQUEADO
 * e 1 em IN_PROGRESS (ignora o apto). Sem canal externo: só SQL.
 */
import { Pool } from 'pg';
import type { Request, Response } from 'express';

process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

import { WJAFunnelController } from '../../src/modules/matching/interfaces/controllers/WJAFunnelController';
import { loadStageCounts } from '../../src/modules/matching/interfaces/controllers/vacancyListHelpers';
import { GetFunnelByWorkerUseCase } from '../../src/modules/matching/application/GetFunnelByWorkerUseCase';
import { GetFunnelTableUseCase } from '../../src/modules/matching/application/GetFunnelTableUseCase';
import { WorkerApplicationRepository } from '../../src/modules/matching/infrastructure/WorkerApplicationRepository';
import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ID = {
  patient: 'a0670000-0000-4000-a001-000000000001',
  job: 'a0670000-0000-4000-a002-000000000001',
  apto: 'a0670000-0000-4000-a003-000000000001',
  naoApto: 'a0670000-0000-4000-a003-000000000002',
  semDoc: 'a0670000-0000-4000-a003-000000000003',
  prog: 'a0670000-0000-4000-a003-000000000004',
};
const WORKERS = Object.values(ID).filter((v) => v.includes('a003'));

async function makeWorker(id: string, tag: string, docs: 'validated' | 'unvalidated' | 'none' | 'incomplete'): Promise<void> {
  await pool.query(
    `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone, profession,
       first_name_encrypted, last_name_encrypted, sex_encrypted, gender_encrypted, birth_date_encrypted,
       document_number_encrypted, document_type, languages_encrypted, knowledge_level, title_certificate,
       years_experience, experience_types, preferred_types, preferred_age_range)
     VALUES ($1, $2, $3, $4, 'REGISTERED', 'AR', 'America/Argentina/Buenos_Aires', 'CAREGIVER',
       'enc', 'enc', 'enc', 'enc', 'enc', 'enc', 'DNI', 'enc', 'BASIC', 'DEGREE', '3-5',
       ARRAY['TEA'], ARRAY['TEA'], ARRAY['CHILD'])`,
    [id, `uid-067-${tag}`, `apto-067-${tag}@e2e.test`, `+54116700${tag.length}${Math.floor(Math.random() * 1e5)}`],
  );
  if (docs === 'incomplete') return;
  await pool.query(`INSERT INTO worker_service_areas (worker_id, address_line, radius_km) VALUES ($1, 'Av. Test 1', 5)`, [id]);
  await pool.query(
    `INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone)
     VALUES ($1, 1, '08:00', '18:00', 'America/Argentina/Buenos_Aires')`,
    [id],
  );
  if (docs === 'none') return;
  const validations = docs === 'validated'
    ? JSON.stringify({ identity_document: { validated_by: 'qa', validated_at: '2026-10-22' }, criminal_record: { validated_by: 'qa', validated_at: '2026-10-22' } })
    : '{}';
  await pool.query(
    `INSERT INTO worker_documents (worker_id, identity_document_url, criminal_record_url, document_validations)
     VALUES ($1, 'http://e.com/id', 'http://e.com/cr', $2::jsonb)`,
    [id, validations],
  );
}

async function wja(workerId: string, stage: string): Promise<void> {
  await pool.query(
    `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source, messaged_at)
     VALUES ($1, $2, $3, 'talentum', now())`,
    [workerId, ID.job, stage],
  );
}

async function limpar(): Promise<void> {
  await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id = $1`, [ID.job]);
  await pool.query(`DELETE FROM worker_documents WHERE worker_id = ANY($1::uuid[])`, [WORKERS]);
  await pool.query(`DELETE FROM worker_availability WHERE worker_id = ANY($1::uuid[])`, [WORKERS]);
  await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = ANY($1::uuid[])`, [WORKERS]);
  await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [WORKERS]);
  await pool.query(`DELETE FROM job_postings WHERE id = $1`, [ID.job]);
  await pool.query(`DELETE FROM patients WHERE id = $1`, [ID.patient]);
}

beforeAll(async () => {
  await limpar();
  await pool.query(
    `INSERT INTO patients (id, clickup_task_id, country, first_name, last_name) VALUES ($1, 'apto-067-task', 'AR', 'Apto', 'Teste')`,
    [ID.patient],
  );
  const { rows } = await pool.query<{ vn: string }>("SELECT nextval('job_postings_vacancy_number_seq') AS vn");
  await pool.query(
    `INSERT INTO job_postings (id, vacancy_number, case_number, patient_id, title, description, country, status, is_draft)
     VALUES ($1, $2, 99067, $3, 'apto-067', '', 'AR', 'SEARCHING', false)`,
    [ID.job, parseInt(rows[0].vn, 10), ID.patient],
  );
  await makeWorker(ID.apto, 'a', 'validated');
  await makeWorker(ID.naoApto, 'b', 'unvalidated');
  await makeWorker(ID.semDoc, 'cc', 'none');
  await makeWorker(ID.prog, 'dd', 'incomplete');
  await wja(ID.apto, 'QUALIFIED');
  await wja(ID.naoApto, 'QUALIFIED');
  await wja(ID.semDoc, 'IN_DOUBT');
  await wja(ID.prog, 'IN_PROGRESS');
});

afterAll(async () => {
  await limpar();
  await pool.end();
  await DatabaseConnection.getInstance().getPool().end().catch(() => undefined);
});

describe('apto nos cinco leitores (spec 067 F3) — SQL real', () => {
  it('pré-condição: o dono diz apto só para o prestador validado', async () => {
    const { rows } = await pool.query<{ id: string; apto: boolean }>(
      `SELECT id, fn_worker_is_apto(id) AS apto FROM workers WHERE id = ANY($1::uuid[])`, [WORKERS],
    );
    const por = Object.fromEntries(rows.map((r) => [r.id, r.apto]));
    expect(por[ID.apto]).toBe(true);
    expect(por[ID.naoApto]).toBe(false);
    expect(por[ID.semDoc]).toBe(false);
  });

  it('C1 Kanban da vaga: 1 em COMPLETED, 2 em BLOQUEADO, 1 em IN_PROGRESS; internalStage preservado', async () => {
    const req = { params: { id: ID.job }, body: {}, query: {} } as unknown as Request;
    const res = { json: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis() } as unknown as Response;
    await new WJAFunnelController().getEncuadreFunnel(req, res);
    const { stages } = (res.json as jest.Mock).mock.calls[0][0].data as { stages: Record<string, Array<{ workerId: string; internalStage: string }>> };
    expect(stages.COMPLETED.map((c) => c.workerId)).toEqual([ID.apto]);
    expect(stages.BLOQUEADO.map((c) => c.workerId).sort()).toEqual([ID.naoApto, ID.semDoc].sort());
    expect(stages.BLOQUEADO.map((c) => c.internalStage).sort()).toEqual(['IN_DOUBT', 'QUALIFIED']);
    expect(stages.IN_PROGRESS.map((c) => c.workerId)).toEqual([ID.prog]);
  });

  it('C2 tabela do funil: kanbanColumn e counts.columns batem com o Kanban', async () => {
    const out = await new GetFunnelTableUseCase().execute(ID.job, 'ALL');
    const col = Object.fromEntries(out.rows.map((r) => [r.workerId, r.kanbanColumn]));
    expect(col[ID.apto]).toBe('COMPLETED');
    expect(col[ID.naoApto]).toBe('BLOQUEADO');
    expect(col[ID.semDoc]).toBe('BLOQUEADO');
    expect(col[ID.prog]).toBe('IN_PROGRESS');
    expect(out.counts.columns.COMPLETED).toBe(1);
    expect(out.counts.columns.BLOQUEADO).toBe(2);
    expect(Object.values(out.counts.columns).reduce((a, n) => a + n, 0)).toBe(4);
  });

  it('C3 contadores da lista de vagas: mesmo recorte, a soma das colunas = total', async () => {
    const counts = (await loadStageCounts(DatabaseConnection.getInstance().getPool(), [ID.job])).get(ID.job)!;
    expect(counts.COMPLETED).toBe(1);
    expect(counts.BLOQUEADO).toBe(2);
    expect(counts.IN_PROGRESS).toBe(1);
    expect(Object.values(counts).reduce((a, n) => a + n, 0)).toBe(4);
  });

  it('C4 Gestão à Vista: porEtapa e consolidado separam COMPLETED de BLOQUEADO', async () => {
    const r = await new GetFunnelByWorkerUseCase(DatabaseConnection.getInstance().getPool()).execute();
    expect(r.porEtapa.COMPLETED).toBe(1);
    expect(r.porEtapa.BLOQUEADO).toBe(2);
    expect(r.consolidado.BLOQUEADO).toBe(2);
    expect(Object.values(r.consolidado).reduce((a, n) => a + n, 0)).toBe(r.total);
  });

  it('C5 ficha do prestador: o prestador não apto vê BLOQUEADO na vaga; o apto vê COMPLETED', async () => {
    const repo = new WorkerApplicationRepository();
    expect((await repo.listEngagementsByWorker(ID.apto))[0].kanbanStage).toBe('COMPLETED');
    expect((await repo.listEngagementsByWorker(ID.naoApto))[0].kanbanStage).toBe('BLOQUEADO');
    expect((await repo.listEngagementsByWorker(ID.prog))[0].kanbanStage).toBe('IN_PROGRESS');
  });

  it('a validação de um documento move o card (sem evento): o leitor lê o dono ao vivo (FR-11)', async () => {
    await pool.query(
      `UPDATE worker_documents SET document_validations =
         '{"identity_document":{"validated_by":"qa","validated_at":"x"},"criminal_record":{"validated_by":"qa","validated_at":"x"}}'::jsonb
       WHERE worker_id = $1`, [ID.naoApto],
    );
    const counts = (await loadStageCounts(DatabaseConnection.getInstance().getPool(), [ID.job])).get(ID.job)!;
    expect(counts.COMPLETED).toBe(2);
    expect(counts.BLOQUEADO).toBe(1);
  });
});
