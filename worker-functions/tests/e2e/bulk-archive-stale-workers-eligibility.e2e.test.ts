/**
 * bulk-archive-stale-workers-eligibility.e2e.test.ts
 *
 * Testa o SQL LITERAL (ELIGIBILITY_QUERY/REVIEW_QUERY) de
 * scripts/bulk-archive-stale-workers-2026-01-30.ts contra um Postgres real.
 *
 * Por quê: essa query tinha um bug de semântica de NULL em SQL
 * (`NULL >= data` avalia UNKNOWN, nunca TRUE) que em 10/08/2026 arquivou 1.998
 * de 5.169 workers por engano — a mesma classe de bug que este arquivo passa a
 * impedir de voltar sem que ninguém note (a validação anterior tinha sido só
 * dry-run manual em produção, nunca automatizada). As consts são IMPORTADAS do
 * script, não copiadas — se alguém editar o SQL do script sem atualizar este
 * teste, o teste roda a versão nova mesmo assim (sem risco de drift).
 *
 * Cobertura mínima pedida:
 *   E1 — worker com encuadre recente (>= cutoff) → NÃO elegível
 *   E2 — worker com TODAS as datas de encuadre NULL → cai na REVIEW_QUERY,
 *        não na elegibilidade automática (é o próprio bug do incidente)
 *   E3 — worker com sentinela 2000-01-01 → segue contando como antigo (elegível)
 *
 * Bônus (mesma bateria, já que a fixture está montada):
 *   E4 — merged_into_id preenchido → excluído mesmo com histórico antigo
 *   E5 — ana_care_status='Activo' → excluído (pode estar cobrindo paciente)
 *   E6 — worker_availability recente → excluído (trava de PESSOA viva, D103/D105)
 */

import { Pool } from 'pg';
import {
  ELIGIBILITY_QUERY,
  REVIEW_QUERY,
  CUTOFF_DATE,
  LIVENESS_WINDOW_DAYS,
  EligibleRow,
} from '../../scripts/bulk-archive-stale-workers-2026-01-30';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: DATABASE_URL });

const TEST_EMAIL_DOMAIN = '@bulkarchiveelig.test';

async function insertWorker(overrides: {
  status?: string;
  authUid?: string;
  phone?: string | null;
  anaCareStatus?: string | null;
  mergedIntoId?: string | null;
} = {}): Promise<string> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const authUid = overrides.authUid ?? `uid-${suffix}`;
  const email = `worker-${suffix}${TEST_EMAIL_DOMAIN}`;
  const result = await pool.query(
    `INSERT INTO workers (auth_uid, email, country, timezone, status, phone, ana_care_status, merged_into_id)
     VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires', $3, $4, $5, $6)
     RETURNING id`,
    [
      authUid,
      email,
      overrides.status ?? 'REGISTERED',
      overrides.phone ?? null,
      overrides.anaCareStatus ?? null,
      overrides.mergedIntoId ?? null,
    ],
  );
  return result.rows[0].id as string;
}

async function insertEncuadre(workerId: string, recruitmentDate: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO encuadres (worker_id, recruitment_date) VALUES ($1, $2)`,
    [workerId, recruitmentDate],
  );
}

async function insertAvailability(workerId: string, createdAt: Date): Promise<void> {
  await pool.query(
    `INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone, created_at, updated_at)
     VALUES ($1, 1, '08:00', '12:00', 'America/Argentina/Buenos_Aires', $2, $2)`,
    [workerId, createdAt],
  );
}

async function runEligibility(): Promise<EligibleRow[]> {
  const { rows } = await pool.query<EligibleRow>(ELIGIBILITY_QUERY, [CUTOFF_DATE, LIVENESS_WINDOW_DAYS]);
  return rows;
}

async function runReview(): Promise<Array<{ worker_id: string }>> {
  const { rows } = await pool.query(REVIEW_QUERY);
  return rows;
}

afterEach(async () => {
  await pool.query(`DELETE FROM workers WHERE email LIKE '%${TEST_EMAIL_DOMAIN}'`);
});

afterAll(async () => {
  await pool.end();
});

describe('E1 — encuadre com recruitment_date >= cutoff', () => {
  it('NÃO é elegível (histórico não é inteiramente antigo)', async () => {
    const workerId = await insertWorker();
    await insertEncuadre(workerId, '2026-03-01'); // depois do cutoff 2026-01-30

    const eligible = await runEligibility();
    const review = await runReview();

    expect(eligible.map((r) => r.worker_id)).not.toContain(workerId);
    expect(review.map((r) => r.worker_id)).not.toContain(workerId);
  });
});

describe('E2 — o bug do incidente: TODAS as recruitment_date são NULL', () => {
  it('NÃO cai na elegibilidade automática — cai na fila de REVISÃO', async () => {
    const workerId = await insertWorker();
    await insertEncuadre(workerId, null);
    await insertEncuadre(workerId, null); // mais de uma linha, todas NULL

    const eligible = await runEligibility();
    const review = await runReview();

    expect(eligible.map((r) => r.worker_id)).not.toContain(workerId);
    expect(review.map((r) => r.worker_id)).toContain(workerId);
  });
});

describe('E3 — sentinela 2000-01-01', () => {
  it('segue contando como antigo (elegível)', async () => {
    const workerId = await insertWorker();
    await insertEncuadre(workerId, '2000-01-01');

    const eligible = await runEligibility();
    const review = await runReview();

    expect(eligible.map((r) => r.worker_id)).toContain(workerId);
    expect(review.map((r) => r.worker_id)).not.toContain(workerId);
  });
});

describe('E4 — merged_into_id preenchido', () => {
  it('excluído mesmo com histórico inteiramente antigo', async () => {
    const targetId = await insertWorker();
    const workerId = await insertWorker({ mergedIntoId: targetId });
    await insertEncuadre(workerId, '2000-01-01');

    const eligible = await runEligibility();
    expect(eligible.map((r) => r.worker_id)).not.toContain(workerId);
  });
});

describe('E5 — ana_care_status=Activo', () => {
  it('excluído mesmo com histórico inteiramente antigo (pode estar cobrindo paciente)', async () => {
    const workerId = await insertWorker({ anaCareStatus: 'Activo' });
    await insertEncuadre(workerId, '2000-01-01');

    const eligible = await runEligibility();
    expect(eligible.map((r) => r.worker_id)).not.toContain(workerId);
  });
});

describe('E6 — disponibilidade recente (pessoa viva, D103/D105)', () => {
  it('excluído mesmo com histórico inteiramente antigo', async () => {
    const workerId = await insertWorker();
    await insertEncuadre(workerId, '2000-01-01');
    await insertAvailability(workerId, new Date()); // agora, dentro da janela de 90d

    const eligible = await runEligibility();
    expect(eligible.map((r) => r.worker_id)).not.toContain(workerId);
  });

  it('NÃO protege se a disponibilidade for mais antiga que a janela', async () => {
    const workerId = await insertWorker();
    await insertEncuadre(workerId, '2000-01-01');
    const staleDate = new Date(Date.now() - (LIVENESS_WINDOW_DAYS + 10) * 24 * 60 * 60 * 1000);
    await insertAvailability(workerId, staleDate);

    const eligible = await runEligibility();
    expect(eligible.map((r) => r.worker_id)).toContain(workerId);
  });
});
