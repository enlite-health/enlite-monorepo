/**
 * talentum-prescreening.test.ts
 *
 * Testa o schema, estratégias de upsert e o endpoint HTTP do webhook de
 * prescreening do Talentum (migration 057 + Steps 5/6 do roadmap).
 *
 * Parte 1 — DB-level (schema + upserts + repository):
 *   - Upsert incremental, COALESCE, ON CONFLICT, CHECK constraints, Cascade delete
 *
 * Parte 2 — HTTP endpoint: POST /api/webhooks/talentum/prescreening
 *   - 400 payload inválido (Zod)
 *   - 200 happy path: INITIATED, IN_PROGRESS, COMPLETED
 *   - Lookup worker por email + job posting por ILIKE
 *   - COALESCE via endpoint: job_posting_id preenchido no POST seguinte
 *   - 401 quando USE_MOCK_AUTH=false (skip em ambiente de teste)
 *
 * Usa MockAuth (USE_MOCK_AUTH=true) — token Google ID Token bypassed.
 */

import { Pool, PoolClient } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';
import { TalentumPrescreeningPayloadSchema } from '../../src/modules/integration/interfaces/webhooks/validators/talentumPrescreeningSchema';
import { TalentumPrescreeningRepository } from '../../src/modules/matching/infrastructure/TalentumPrescreeningRepository';
import type { TalentumPrescreeningStatus } from '../../src/modules/matching/domain/TalentumPrescreening';
import { BASE_DATA, envelope, type QuestionItem } from '../fixtures/talentumPayload';
import { postTalentumDrainAndRead, readTalentumMirror, TALENTUM_WEBHOOK } from './helpers/talentumWebhook';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// ─────────────────────────────────────────────────────────────────
// Helpers finos — delegam ao Repository real (fonte única de verdade da SQL).
// Assinatura aceita PoolClient apenas para compatibilidade com os testes
// existentes; o client é ignorado (o repo usa o pool singleton que aponta
// para o mesmo DATABASE_URL do teste).
//
// Instanciação lazy: DatabaseConnection crasha se DATABASE_URL ainda não
// foi setado no process.env no momento do import; por isso esperamos até
// a primeira chamada do helper (já dentro do `beforeAll` dos testes).
// ─────────────────────────────────────────────────────────────────

let _repo: TalentumPrescreeningRepository | null = null;
function repo(): TalentumPrescreeningRepository {
  if (!_repo) {
    // DatabaseConnection lê DATABASE_URL na primeira instanciação e crasha se ausente.
    // Garante fallback para o DB de teste local (o jest não carrega .env.test).
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ||
      'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
    _repo = new TalentumPrescreeningRepository();
  }
  return _repo;
}

async function upsertQuestion(
  _client: PoolClient,
  questionId: string,
  question: string,
  responseType: string,
): Promise<string> {
  const { question: created } = await repo().upsertQuestion({ questionId, question, responseType });
  return created.id;
}

async function upsertPrescreening(
  _client: PoolClient,
  opts: {
    talentumPrescreeningId: string;
    talentumProfileId: string;
    workerId: string | null;
    jobPostingId: string | null;
    jobCaseName: string;
    status: TalentumPrescreeningStatus;
  },
): Promise<{ id: string; workerId: string | null; jobPostingId: string | null }> {
  const { prescreening } = await repo().upsertPrescreening(opts);
  return {
    id: prescreening.id,
    workerId: prescreening.workerId,
    jobPostingId: prescreening.jobPostingId,
  };
}

async function upsertResponse(
  _client: PoolClient,
  prescreeningId: string,
  questionId: string,
  answer: string | null,
  source: 'register' | 'prescreening',
): Promise<string> {
  const { response } = await repo().upsertResponse({
    prescreeningId,
    questionId,
    answer,
    responseSource: source,
  });
  return response.id;
}

// ─────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────

describe('Talentum Prescreening — schema e upserts E2E', () => {
  let pool: Pool;
  let client: PoolClient;

  // IDs de fixtures reutilizados entre testes dentro do mesmo describe
  let workerFixtureId: string;
  let jobPostingFixtureId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    client = await pool.connect();

    // Worker mínimo — necessário apenas para testar FK resolution
    const { rows: wRows } = await client.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status)
       VALUES ('talentum-e2e-uid', 'talentum-e2e@test.local', 'INCOMPLETE_REGISTER')
       ON CONFLICT DO NOTHING
       RETURNING id`,
    );
    if (wRows.length > 0) {
      workerFixtureId = wRows[0].id;
    } else {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM workers WHERE auth_uid = 'talentum-e2e-uid'`,
      );
      workerFixtureId = rows[0].id;
    }

    // Job posting mínimo
    const { rows: jpRows } = await client.query<{ id: string }>(
      `INSERT INTO job_postings (title, description, status)
       VALUES ('Caso Teste XYZ', 'Descrição do caso de teste', 'SEARCHING')
       RETURNING id`,
    );
    jobPostingFixtureId = jpRows[0].id;
  });

  afterAll(async () => {
    await client.query('DELETE FROM talentum_prescreening_responses');
    await client.query('DELETE FROM talentum_prescreenings');
    await client.query('DELETE FROM talentum_questions');
    await client.query('DELETE FROM job_postings WHERE id = $1', [jobPostingFixtureId]);
    await client.query('DELETE FROM workers WHERE auth_uid = $1', ['talentum-e2e-uid']);
    client.release();
    await pool.end();
  });

  afterEach(async () => {
    // Limpa dados talentum entre testes para isolamento
    await client.query('DELETE FROM talentum_prescreening_responses');
    await client.query('DELETE FROM talentum_prescreenings');
    await client.query('DELETE FROM talentum_questions');
  });

  // ─────────────────────────────────────────────────────────────────
  // 1. Estrutura do schema
  // ─────────────────────────────────────────────────────────────────

  describe('schema — 3 tabelas criadas', () => {
    it('talentum_prescreenings existe com colunas obrigatórias', async () => {
      const { rows } = await client.query(
        `SELECT column_name, is_nullable
         FROM information_schema.columns
         WHERE table_name = 'talentum_prescreenings'
         ORDER BY ordinal_position`,
      );
      const colMap = Object.fromEntries(rows.map((r: { column_name: string; is_nullable: string }) => [r.column_name, r.is_nullable]));

      expect(colMap['id']).toBe('NO');
      expect(colMap['talentum_prescreening_id']).toBe('NO');
      expect(colMap['talentum_profile_id']).toBe('NO');
      expect(colMap['worker_id']).toBe('YES');          // nullable intencional
      expect(colMap['job_posting_id']).toBe('YES');     // nullable intencional
      expect(colMap['job_case_name']).toBe('NO');
      expect(colMap['status']).toBe('NO');
      expect(colMap['created_at']).toBe('NO');
      expect(colMap['updated_at']).toBe('NO');
    });

    it('talentum_questions existe com colunas obrigatórias', async () => {
      const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'talentum_questions'`,
      );
      const cols = rows.map((r: { column_name: string }) => r.column_name);
      expect(cols).toContain('question_id');
      expect(cols).toContain('question');
      expect(cols).toContain('response_type');
    });

    it('talentum_prescreening_responses existe com UNIQUE (prescreening_id, question_id, response_source)', async () => {
      const { rows } = await client.query(
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'talentum_prescreening_responses'
           AND indexname LIKE '%prescreening_id%question_id%'`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    it('todos os indexes de performance existem', async () => {
      const { rows } = await client.query(
        `SELECT indexname FROM pg_indexes WHERE tablename LIKE 'talentum%'`,
      );
      const names = rows.map((r: { indexname: string }) => r.indexname);

      expect(names).toContain('idx_talentum_prescreenings_worker');
      expect(names).toContain('idx_talentum_prescreenings_posting');
      expect(names).toContain('idx_talentum_prescreenings_status');
      expect(names).toContain('idx_talentum_prescreenings_profile');
      expect(names).toContain('idx_talentum_responses_prescreening');
      expect(names).toContain('idx_talentum_responses_question');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. CHECK constraints
  // ─────────────────────────────────────────────────────────────────

  describe('CHECK constraints', () => {
    it('status inválido em talentum_prescreenings → erro de constraint', async () => {
      await expect(
        client.query(
          `INSERT INTO talentum_prescreenings
             (talentum_prescreening_id, talentum_profile_id, job_case_name, status)
           VALUES ('bad-status-test', 'p1', 'Caso', 'INVALID_STATUS')`,
        ),
      ).rejects.toThrow(/violates check constraint/);
    });

    it('status ANALYZED é aceito pelo CHECK constraint', async () => {
      const psc = await upsertPrescreening(client, {
        talentumPrescreeningId: 'psc-analyzed-test',
        talentumProfileId: 'prof-analyzed',
        workerId: null,
        jobPostingId: null,
        jobCaseName: 'Caso Analyzed',
        status: 'ANALYZED',
      });

      expect(psc.id).toBeTruthy();

      const { rows } = await client.query(
        `SELECT status FROM talentum_prescreenings WHERE id = $1`,
        [psc.id],
      );
      expect(rows[0].status).toBe('ANALYZED');
    });

    it('response_source inválido em talentum_prescreening_responses → erro de constraint', async () => {
      const qId = await upsertQuestion(client, 'q-constraint-test', 'Pergunta?', 'TEXT');
      const psc = await upsertPrescreening(client, {
        talentumPrescreeningId: 'psc-constraint-test',
        talentumProfileId: 'prof-1',
        workerId: null,
        jobPostingId: null,
        jobCaseName: 'Caso',
        status: 'INITIATED',
      });

      await expect(
        client.query(
          `INSERT INTO talentum_prescreening_responses
             (prescreening_id, question_id, answer, response_source)
           VALUES ($1, $2, 'resposta', 'invalid_source')`,
          [psc.id, qId],
        ),
      ).rejects.toThrow(/violates check constraint/);
    });

    it.each([
      'INITIATED',
      'IN_PROGRESS',
      'COMPLETED',
      'ANALYZED',
      'QUALIFIED',
      'NOT_QUALIFIED',
      'IN_DOUBT',
      'PENDING',
    ] as const)(
      'status %s é aceito pelo CHECK constraint',
      async (status) => {
        const psc = await upsertPrescreening(client, {
          talentumPrescreeningId: `chk-status-${status}`,
          talentumProfileId: `chk-prof-${status}`,
          workerId: null,
          jobPostingId: null,
          jobCaseName: `Caso CHECK ${status}`,
          status,
        });

        expect(psc.id).toBeTruthy();

        const { rows } = await client.query<{ status: string }>(
          `SELECT status FROM talentum_prescreenings WHERE id = $1`,
          [psc.id],
        );
        expect(rows[0].status).toBe(status);
      },
    );

    it('todos os effectiveStatus que o código produz são aceitos pelo banco', async () => {
      // Valores que persistPrescreening() pode gravar:
      // - subtypes diretos: INITIATED, IN_PROGRESS, COMPLETED
      // - statusLabels quando subtype=ANALYZED: QUALIFIED, NOT_QUALIFIED, IN_DOUBT
      // - caso especial PENDING → gravado como ANALYZED
      const effectiveStatuses = [
        'INITIATED',
        'IN_PROGRESS',
        'COMPLETED',
        'QUALIFIED',
        'NOT_QUALIFIED',
        'IN_DOUBT',
        'ANALYZED',
      ] as const;

      for (const status of effectiveStatuses) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO talentum_prescreenings
             (talentum_prescreening_id, talentum_profile_id, job_case_name, status)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (talentum_prescreening_id, talentum_profile_id) DO UPDATE SET
             status     = EXCLUDED.status,
             updated_at = NOW()
           RETURNING id`,
          [
            `chk-effective-${status}`,
            `chk-eff-prof-${status}`,
            `Caso Effective ${status}`,
            status,
          ],
        );
        expect(rows[0].id).toBeTruthy();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. Fluxo incremental — POST 1: INITIATED sem respostas
  // ─────────────────────────────────────────────────────────────────

  describe('POST 1 — INITIATED, worker e vaga desconhecidos', () => {
    it('salva prescreening com worker_id = null e job_posting_id = null', async () => {
      const psc = await upsertPrescreening(client, {
        talentumPrescreeningId: 'psc-flow-001',
        talentumProfileId: 'profile-abc',
        workerId: null,
        jobPostingId: null,
        jobCaseName: 'Caso XYZ',
        status: 'INITIATED',
      });

      expect(psc.id).toBeTruthy();
      expect(psc.workerId).toBeNull();
      expect(psc.jobPostingId).toBeNull();

      const { rows } = await client.query(
        `SELECT status FROM talentum_prescreenings WHERE id = $1`,
        [psc.id],
      );
      expect(rows[0].status).toBe('INITIATED');
    });

    it('response.state vazio → nenhuma resposta salva', async () => {
      const psc = await upsertPrescreening(client, {
        talentumPrescreeningId: 'psc-flow-002',
        talentumProfileId: 'profile-abc',
        workerId: null,
        jobPostingId: null,
        jobCaseName: 'Caso XYZ',
        status: 'INITIATED',
      });

      const { rows } = await client.query(
        `SELECT COUNT(*) AS cnt FROM talentum_prescreening_responses WHERE prescreening_id = $1`,
        [psc.id],
      );
      expect(Number(rows[0].cnt)).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 4. Fluxo incremental — POST 2: IN_PROGRESS com 1 resposta
  // ─────────────────────────────────────────────────────────────────

  describe('POST 2 — IN_PROGRESS, primeira resposta', () => {
    it('atualiza status INITIATED → IN_PROGRESS via ON CONFLICT', async () => {
      // POST 1
      await upsertPrescreening(client, {
        talentumPrescreeningId: 'psc-flow-003',
        talentumProfileId: 'profile-abc',
        workerId: null, jobPostingId: null,
        jobCaseName: 'Caso XYZ', status: 'INITIATED',
      });

      // POST 2
      const psc = await upsertPrescreening(client, {
        talentumPrescreeningId: 'psc-flow-003',
        talentumProfileId: 'profile-abc',
        workerId: null, jobPostingId: null,
        jobCaseName: 'Caso XYZ', status: 'IN_PROGRESS',
      });

      const { rows } = await client.query(
        `SELECT status FROM talentum_prescreenings WHERE id = $1`,
        [psc.id],
      );
      expect(rows[0].status).toBe('IN_PROGRESS');
    });

    it('salva resposta com source=prescreening', async () => {
      const psc = await upsertPrescreening(client, {
        talentumPrescreeningId: 'psc-flow-004',
        talentumProfileId: 'profile-abc',
        workerId: null, jobPostingId: null,
        jobCaseName: 'Caso XYZ', status: 'IN_PROGRESS',
      });
      const qId = await upsertQuestion(client, 'q-exp-001', 'Tem experiência com idosos?', 'BOOLEAN');
      await upsertResponse(client, psc.id, qId, 'Sim', 'prescreening');

      const { rows } = await client.query(
        `SELECT answer, response_source
         FROM talentum_prescreening_responses
         WHERE prescreening_id = $1`,
        [psc.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].answer).toBe('Sim');
      expect(rows[0].response_source).toBe('prescreening');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 5. Fluxo incremental — POST N: COMPLETED com múltiplas respostas
  // ─────────────────────────────────────────────────────────────────

  describe('POST N — COMPLETED, respostas acumuladas', () => {
    it('simula 3 POSTs incrementais — estado final correto', async () => {
      const extId = 'psc-full-flow-001';

      // POST 1 — INITIATED, sem respostas
      await upsertPrescreening(client, {
        talentumPrescreeningId: extId, talentumProfileId: 'prof-X',
        workerId: null, jobPostingId: null,
        jobCaseName: 'Caso Full', status: 'INITIATED',
      });

      // POST 2 — IN_PROGRESS, Q1 respondida
      const psc2 = await upsertPrescreening(client, {
        talentumPrescreeningId: extId, talentumProfileId: 'prof-X',
        workerId: null, jobPostingId: null,
        jobCaseName: 'Caso Full', status: 'IN_PROGRESS',
      });
      const q1Id = await upsertQuestion(client, 'q-full-001', 'Tem CNH?', 'BOOLEAN');
      await upsertResponse(client, psc2.id, q1Id, 'Não', 'prescreening');

      // POST 3 — COMPLETED, Q1 + Q2 + registerQuestion respondidas
      const psc3 = await upsertPrescreening(client, {
        talentumPrescreeningId: extId, talentumProfileId: 'prof-X',
        workerId: null, jobPostingId: null,
        jobCaseName: 'Caso Full', status: 'COMPLETED',
      });
      const q2Id = await upsertQuestion(client, 'q-full-002', 'Disponibilidade noturna?', 'BOOLEAN');
      const qRegId = await upsertQuestion(client, 'q-full-reg-001', 'Cidade atual?', 'TEXT');

      // Q1 reenviado com mesma resposta (POST incremental — objeto completo)
      await upsertResponse(client, psc3.id, q1Id, 'Não', 'prescreening');
      await upsertResponse(client, psc3.id, q2Id, 'Sim', 'prescreening');
      await upsertResponse(client, psc3.id, qRegId, 'São Paulo', 'register');

      // Verificações finais
      expect(psc2.id).toBe(psc3.id); // mesmo registro — ON CONFLICT retorna o mesmo id

      const { rows: pscRow } = await client.query(
        `SELECT status FROM talentum_prescreenings WHERE id = $1`,
        [psc3.id],
      );
      expect(pscRow[0].status).toBe('COMPLETED');

      const { rows: respRows } = await client.query(
        `SELECT response_source, answer FROM talentum_prescreening_responses
         WHERE prescreening_id = $1
         ORDER BY response_source, created_at`,
        [psc3.id],
      );
      // 2 respostas prescreening + 1 register
      expect(respRows).toHaveLength(3);
      const prescreeningAnswers = respRows
        .filter((r: { response_source: string }) => r.response_source === 'prescreening')
        .map((r: { answer: string }) => r.answer);
      expect(prescreeningAnswers).toContain('Não');
      expect(prescreeningAnswers).toContain('Sim');

      const registerAnswers = respRows.filter((r: { response_source: string }) => r.response_source === 'register');
      expect(registerAnswers[0].answer).toBe('São Paulo');
    });

    it('mesma questionId em register e prescreening → 2 linhas distintas (response_source discrimina)', async () => {
      const psc = await upsertPrescreening(client, {
        talentumPrescreeningId: 'psc-dual-source-001',
        talentumProfileId: 'prof-Y',
        workerId: null, jobPostingId: null,
        jobCaseName: 'Caso Dual', status: 'COMPLETED',
      });
      const qId = await upsertQuestion(client, 'q-dual-001', 'Pergunta duplicada?', 'TEXT');

      await upsertResponse(client, psc.id, qId, 'Resposta cadastro', 'register');
      await upsertResponse(client, psc.id, qId, 'Resposta vaga', 'prescreening');

      const { rows } = await client.query(
        `SELECT response_source, answer FROM talentum_prescreening_responses
         WHERE prescreening_id = $1 AND question_id = $2`,
        [psc.id, qId],
      );
      expect(rows).toHaveLength(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 6. COALESCE — worker_id null → preenchido no POST seguinte
  // ─────────────────────────────────────────────────────────────────

  describe('COALESCE — worker_id resolvido em POST posterior', () => {
    it('POST 1 sem worker → worker_id null; POST 2 com worker → worker_id preenchido', async () => {
      // POST 1: worker ainda não existe no sistema
      await upsertPrescreening(client, {
        talentumPrescreeningId: 'psc-coalesce-001',
        talentumProfileId: 'prof-Z',
        workerId: null,
        jobPostingId: null,
        jobCaseName: 'Caso Coalesce', status: 'IN_PROGRESS',
      });

      // POST 2: worker foi importado entre os POSTs — resolve a FK
      const psc2 = await upsertPrescreening(client, {
        talentumPrescreeningId: 'psc-coalesce-001',
        talentumProfileId: 'prof-Z',
        workerId: workerFixtureId,   // agora temos o UUID interno
        jobPostingId: null,
        jobCaseName: 'Caso Coalesce', status: 'IN_PROGRESS',
      });

      expect(psc2.workerId).toBe(workerFixtureId);

      // POST 3: reenvia worker_id null (worker pode não ser re-buscado se já estava null no payload)
      // COALESCE garante que worker_id já preenchido NÃO é sobrescrito por null
      const psc3 = await upsertPrescreening(client, {
        talentumPrescreeningId: 'psc-coalesce-001',
        talentumProfileId: 'prof-Z',
        workerId: null,   // FK não resolvida novamente — mas COALESCE preserva o valor existente
        jobPostingId: null,
        jobCaseName: 'Caso Coalesce', status: 'COMPLETED',
      });

      expect(psc3.workerId).toBe(workerFixtureId); // COALESCE manteve o valor
    });

    it('job_posting_id null → preenchido por COALESCE no POST seguinte', async () => {
      await upsertPrescreening(client, {
        talentumPrescreeningId: 'psc-coalesce-jp-001',
        talentumProfileId: 'prof-Z',
        workerId: null, jobPostingId: null,
        jobCaseName: 'Caso JP', status: 'INITIATED',
      });

      const psc2 = await upsertPrescreening(client, {
        talentumPrescreeningId: 'psc-coalesce-jp-001',
        talentumProfileId: 'prof-Z',
        workerId: null, jobPostingId: jobPostingFixtureId,
        jobCaseName: 'Caso JP', status: 'IN_PROGRESS',
      });

      expect(psc2.jobPostingId).toBe(jobPostingFixtureId);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 7. Idempotência — mesmo payload enviado N vezes não duplica dados
  // ─────────────────────────────────────────────────────────────────

  describe('Idempotência', () => {
    it('mesmo prescreening enviado 3x → exatamente 1 registro', async () => {
      for (let i = 0; i < 3; i++) {
        await upsertPrescreening(client, {
          talentumPrescreeningId: 'psc-idem-001',
          talentumProfileId: 'prof-idem',
          workerId: null, jobPostingId: null,
          jobCaseName: 'Caso Idem', status: 'INITIATED',
        });
      }

      const { rows } = await client.query(
        `SELECT COUNT(*) AS cnt FROM talentum_prescreenings
         WHERE talentum_prescreening_id = 'psc-idem-001'`,
      );
      expect(Number(rows[0].cnt)).toBe(1);
    });

    it('mesma question enviada N vezes → exatamente 1 registro no catálogo', async () => {
      for (let i = 0; i < 5; i++) {
        await upsertQuestion(client, 'q-idem-001', 'Pergunta idempotente?', 'TEXT');
      }

      const { rows } = await client.query(
        `SELECT COUNT(*) AS cnt FROM talentum_questions WHERE question_id = 'q-idem-001'`,
      );
      expect(Number(rows[0].cnt)).toBe(1);
    });

    it('mesmo (prescreening, question, source) enviado N vezes → 1 resposta, answer atualizada', async () => {
      const psc = await upsertPrescreening(client, {
        talentumPrescreeningId: 'psc-idem-resp-001',
        talentumProfileId: 'prof-idem',
        workerId: null, jobPostingId: null,
        jobCaseName: 'Caso Idem', status: 'IN_PROGRESS',
      });
      const qId = await upsertQuestion(client, 'q-idem-resp-001', 'Mudou de resposta?', 'TEXT');

      await upsertResponse(client, psc.id, qId, 'Resposta 1', 'prescreening');
      await upsertResponse(client, psc.id, qId, 'Resposta 2', 'prescreening'); // worker editou
      await upsertResponse(client, psc.id, qId, 'Resposta Final', 'prescreening');

      const { rows } = await client.query(
        `SELECT COUNT(*) AS cnt, MAX(answer) AS last_answer
         FROM talentum_prescreening_responses
         WHERE prescreening_id = $1 AND question_id = $2 AND response_source = 'prescreening'`,
        [psc.id, qId],
      );
      expect(Number(rows[0].cnt)).toBe(1);
      expect(rows[0].last_answer).toBe('Resposta Final');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 9. Zod Validator — TalentumPrescreeningPayloadSchema (unit puro, sem DB)
  // ─────────────────────────────────────────────────────────────────

  describe('Zod Validator — TalentumPrescreeningPayloadSchema', () => {
    const VALID_PAYLOAD = {
      action: 'PRESCREENING_RESPONSE' as const,
      subtype: 'INITIATED' as const,
      data: {
        prescreening: { id: 'ext-001', name: 'Caso XYZ' },
        profile: {
          id: 'prof-001',
          firstName: 'João',
          lastName: 'Silva',
          email: 'joao@example.com',
          phoneNumber: '+5491112345678',
          cuil: '20-12345678-9',
          registerQuestions: [
            { questionId: 'q-reg-1', question: 'Cidade?', answer: 'SP', responseType: 'TEXT' },
          ],
        },
        response: {
          id: 'resp-001',
          state: [
            { questionId: 'q-vaga-1', question: 'Tem CNH?', answer: 'Não', responseType: 'BOOLEAN' },
          ],
        },
      },
    };

    it('aceita payload PRESCREENING_RESPONSE completo válido sem erros', () => {
      const result = TalentumPrescreeningPayloadSchema.safeParse(VALID_PAYLOAD);
      expect(result.success).toBe(true);
    });

    it('aceita variante PRESCREENING.CREATED (nova vaga aberta)', () => {
      const payload = {
        action: 'PRESCREENING',
        subtype: 'CREATED',
        data: { _id: 'ps-001', name: 'Caso 123' },
      };
      const result = TalentumPrescreeningPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('normaliza email para lowercase', () => {
      const payload = {
        ...VALID_PAYLOAD,
        data: {
          ...VALID_PAYLOAD.data,
          profile: { ...VALID_PAYLOAD.data.profile, email: 'JOAO@EXAMPLE.COM' },
        },
      };
      const result = TalentumPrescreeningPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success && result.data.action === 'PRESCREENING_RESPONSE') {
        expect(result.data.data.profile.email).toBe('joao@example.com');
      }
    });

    it('registerQuestions e state defaultam para [] quando omitidos', () => {
      const payload = {
        action: 'PRESCREENING_RESPONSE',
        subtype: 'INITIATED',
        data: {
          prescreening: VALID_PAYLOAD.data.prescreening,
          profile: {
            id: 'prof-002',
            firstName: 'Ana',
            lastName: 'Lima',
            email: 'ana@test.com',
            phoneNumber: '+5491198765432',
            cuil: '27-98765432-1',
            // registerQuestions omitido
          },
          response: { id: 'resp-002' /* state omitido */ },
        },
      };
      const result = TalentumPrescreeningPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success && result.data.action === 'PRESCREENING_RESPONSE') {
        expect(result.data.data.profile.registerQuestions).toEqual([]);
        expect(result.data.data.response.state).toEqual([]);
      }
    });

    it('aceita answer vazia em registerQuestions (worker ainda não respondeu)', () => {
      const payload = {
        ...VALID_PAYLOAD,
        data: {
          ...VALID_PAYLOAD.data,
          profile: {
            ...VALID_PAYLOAD.data.profile,
            registerQuestions: [
              { questionId: 'q-reg-empty', question: 'Pergunta?', answer: '', responseType: 'BOOLEAN' },
            ],
          },
        },
      };
      const result = TalentumPrescreeningPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('rejeita subtype inválido em PRESCREENING_RESPONSE', () => {
      const payload = { ...VALID_PAYLOAD, subtype: 'CANCELED' };
      const result = TalentumPrescreeningPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it('aceita subtype ANALYZED em PRESCREENING_RESPONSE', () => {
      const payload = { ...VALID_PAYLOAD, subtype: 'ANALYZED' as const };
      const result = TalentumPrescreeningPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success && result.data.action === 'PRESCREENING_RESPONSE') {
        expect(result.data.subtype).toBe('ANALYZED');
      }
    });

    it('rejeita email inválido', () => {
      const payload = {
        ...VALID_PAYLOAD,
        data: {
          ...VALID_PAYLOAD.data,
          profile: { ...VALID_PAYLOAD.data.profile, email: 'nao-e-um-email' },
        },
      };
      const result = TalentumPrescreeningPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it('rejeita campo extra dentro de profile (.strict() aninhado)', () => {
      const payload = {
        ...VALID_PAYLOAD,
        data: {
          ...VALID_PAYLOAD.data,
          profile: { ...VALID_PAYLOAD.data.profile, dadoExtra: true },
        },
      };
      const result = TalentumPrescreeningPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it('rejeita prescreening sem id (campo obrigatório)', () => {
      const { id: _id, ...semId } = VALID_PAYLOAD.data.prescreening;
      const payload = {
        ...VALID_PAYLOAD,
        data: { ...VALID_PAYLOAD.data, prescreening: semId },
      };
      const result = TalentumPrescreeningPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it('rejeita questionId vazio em registerQuestions', () => {
      const payload = {
        ...VALID_PAYLOAD,
        data: {
          ...VALID_PAYLOAD.data,
          profile: {
            ...VALID_PAYLOAD.data.profile,
            registerQuestions: [
              { questionId: '', question: 'Pergunta?', answer: 'Sim', responseType: 'TEXT' },
            ],
          },
        },
      };
      const result = TalentumPrescreeningPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 10. TalentumPrescreeningRepository — métodos de upsert via classe real
  // ─────────────────────────────────────────────────────────────────

  describe('TalentumPrescreeningRepository', () => {
    let repo: TalentumPrescreeningRepository;

    beforeAll(() => {
      // DatabaseConnection é singleton e lê DATABASE_URL na primeira instanciação.
      // Garante o valor antes de criar o repo, pois jest não carrega .env.test automaticamente.
      process.env.DATABASE_URL =
        process.env.DATABASE_URL ||
        'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
      repo = new TalentumPrescreeningRepository();
    });

    describe('upsertPrescreening()', () => {
      it('cria novo prescreening: created=true, campos mapeados em camelCase', async () => {
        const { prescreening, created } = await repo.upsertPrescreening({
          talentumPrescreeningId: 'repo-psc-001',
          talentumProfileId: 'prof-repo-001',
          workerId: null,
          jobPostingId: null,
          jobCaseName: 'Caso Repo',
          status: 'INITIATED',
        });

        expect(created).toBe(true);
        expect(prescreening.id).toBeTruthy();
        expect(prescreening.talentumPrescreeningId).toBe('repo-psc-001');
        expect(prescreening.talentumProfileId).toBe('prof-repo-001');
        expect(prescreening.workerId).toBeNull();
        expect(prescreening.jobPostingId).toBeNull();
        expect(prescreening.jobCaseName).toBe('Caso Repo');
        expect(prescreening.status).toBe('INITIATED');
        expect(prescreening.createdAt).toBeInstanceOf(Date);
        expect(prescreening.updatedAt).toBeInstanceOf(Date);
      });

      it('ON CONFLICT: retorna created=false e atualiza status', async () => {
        await repo.upsertPrescreening({
          talentumPrescreeningId: 'repo-psc-002',
          talentumProfileId: 'prof-repo-002',
          workerId: null, jobPostingId: null,
          jobCaseName: 'Caso', status: 'INITIATED',
        });

        const { prescreening, created } = await repo.upsertPrescreening({
          talentumPrescreeningId: 'repo-psc-002',
          talentumProfileId: 'prof-repo-002',
          workerId: null, jobPostingId: null,
          jobCaseName: 'Caso', status: 'IN_PROGRESS',
        });

        expect(created).toBe(false);
        expect(prescreening.status).toBe('IN_PROGRESS');
      });

      it('COALESCE via repository: worker_id null → preenchido no POST seguinte, não regride', async () => {
        // POST 1: sem worker
        await repo.upsertPrescreening({
          talentumPrescreeningId: 'repo-coalesce-001',
          talentumProfileId: 'prof-coal',
          workerId: null, jobPostingId: null,
          jobCaseName: 'Caso Coalesce', status: 'IN_PROGRESS',
        });

        // POST 2: worker resolvido
        const { prescreening: psc2 } = await repo.upsertPrescreening({
          talentumPrescreeningId: 'repo-coalesce-001',
          talentumProfileId: 'prof-coal',
          workerId: workerFixtureId, jobPostingId: null,
          jobCaseName: 'Caso Coalesce', status: 'IN_PROGRESS',
        });
        expect(psc2.workerId).toBe(workerFixtureId);

        // POST 3: worker_id null de novo — COALESCE preserva o valor existente
        const { prescreening: psc3 } = await repo.upsertPrescreening({
          talentumPrescreeningId: 'repo-coalesce-001',
          talentumProfileId: 'prof-coal',
          workerId: null, jobPostingId: null,
          jobCaseName: 'Caso Coalesce', status: 'COMPLETED',
        });
        expect(psc3.workerId).toBe(workerFixtureId); // COALESCE não sobrescreveu
      });
    });

    describe('upsertQuestion()', () => {
      it('cria nova question: created=true, campos mapeados corretamente', async () => {
        const { question, created } = await repo.upsertQuestion({
          questionId: 'repo-q-001',
          question: 'Tem disponibilidade noturna?',
          responseType: 'BOOLEAN',
        });

        expect(created).toBe(true);
        expect(question.id).toBeTruthy();
        expect(question.questionId).toBe('repo-q-001');
        expect(question.question).toBe('Tem disponibilidade noturna?');
        expect(question.responseType).toBe('BOOLEAN');
        expect(question.createdAt).toBeInstanceOf(Date);
      });

      it('ON CONFLICT: created=false, texto da pergunta atualizado', async () => {
        await repo.upsertQuestion({ questionId: 'repo-q-002', question: 'Original?', responseType: 'TEXT' });

        const { question, created } = await repo.upsertQuestion({
          questionId: 'repo-q-002',
          question: 'Atualizada?',
          responseType: 'TEXT',
        });

        expect(created).toBe(false);
        expect(question.question).toBe('Atualizada?');
      });
    });

    describe('upsertResponse()', () => {
      it('cria resposta: created=true, responseSource e answer corretos', async () => {
        const { prescreening } = await repo.upsertPrescreening({
          talentumPrescreeningId: 'repo-resp-001',
          talentumProfileId: 'prof-resp', workerId: null, jobPostingId: null,
          jobCaseName: 'Caso', status: 'IN_PROGRESS',
        });
        const { question } = await repo.upsertQuestion({
          questionId: 'repo-q-resp-001', question: 'Pergunta?', responseType: 'TEXT',
        });

        const { response, created } = await repo.upsertResponse({
          prescreeningId: prescreening.id,
          questionId: question.id,
          answer: 'Sim',
          responseSource: 'prescreening',
        });

        expect(created).toBe(true);
        expect(response.prescreeningId).toBe(prescreening.id);
        expect(response.questionId).toBe(question.id);
        expect(response.answer).toBe('Sim');
        expect(response.responseSource).toBe('prescreening');
        expect(response.createdAt).toBeInstanceOf(Date);
      });

      it('ON CONFLICT: created=false, answer sobrescrita (worker editou)', async () => {
        const { prescreening } = await repo.upsertPrescreening({
          talentumPrescreeningId: 'repo-resp-002',
          talentumProfileId: 'prof-resp2', workerId: null, jobPostingId: null,
          jobCaseName: 'Caso', status: 'IN_PROGRESS',
        });
        const { question } = await repo.upsertQuestion({
          questionId: 'repo-q-resp-002', question: 'Mudou resposta?', responseType: 'TEXT',
        });

        await repo.upsertResponse({
          prescreeningId: prescreening.id,
          questionId: question.id, answer: 'Resposta 1', responseSource: 'prescreening',
        });
        const { response, created } = await repo.upsertResponse({
          prescreeningId: prescreening.id,
          questionId: question.id, answer: 'Resposta Final', responseSource: 'prescreening',
        });

        expect(created).toBe(false);
        expect(response.answer).toBe('Resposta Final');
      });

      it('aceita answer null (pergunta ainda sem resposta)', async () => {
        const { prescreening } = await repo.upsertPrescreening({
          talentumPrescreeningId: 'repo-resp-null-001',
          talentumProfileId: 'prof-null', workerId: null, jobPostingId: null,
          jobCaseName: 'Caso', status: 'INITIATED',
        });
        const { question } = await repo.upsertQuestion({
          questionId: 'repo-q-null-001', question: 'Sem resposta?', responseType: 'BOOLEAN',
        });

        const { response } = await repo.upsertResponse({
          prescreeningId: prescreening.id,
          questionId: question.id,
          answer: null,
          responseSource: 'register',
        });

        expect(response.answer).toBeNull();
      });
    });

    describe('findByTalentumId()', () => {
      it('retorna o prescreening pelo ID externo Talentum com todos os campos', async () => {
        await repo.upsertPrescreening({
          talentumPrescreeningId: 'repo-find-001',
          talentumProfileId: 'prof-find', workerId: null, jobPostingId: null,
          jobCaseName: 'Caso Find', status: 'INITIATED',
        });

        const found = await repo.findByTalentumId('repo-find-001');

        expect(found).not.toBeNull();
        expect(found!.talentumPrescreeningId).toBe('repo-find-001');
        expect(found!.talentumProfileId).toBe('prof-find');
        expect(found!.jobCaseName).toBe('Caso Find');
        expect(found!.status).toBe('INITIATED');
        expect(found!.workerId).toBeNull();
      });

      it('retorna null para ID inexistente', async () => {
        const found = await repo.findByTalentumId('id-que-nao-existe-9999');
        expect(found).toBeNull();
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 8. Cascade delete
  // ─────────────────────────────────────────────────────────────────

  describe('Cascade delete', () => {
    it('deletar prescreening remove automaticamente todas as respostas (ON DELETE CASCADE)', async () => {
      const psc = await upsertPrescreening(client, {
        talentumPrescreeningId: 'psc-cascade-001',
        talentumProfileId: 'prof-cascade',
        workerId: null, jobPostingId: null,
        jobCaseName: 'Caso Cascade', status: 'COMPLETED',
      });
      const qId = await upsertQuestion(client, 'q-cascade-001', 'Pergunta cascade?', 'TEXT');
      await upsertResponse(client, psc.id, qId, 'Sim', 'prescreening');
      await upsertResponse(client, psc.id, qId, 'Sim', 'register');

      // Confirma que as 2 respostas existem
      const { rows: before } = await client.query(
        `SELECT COUNT(*) AS cnt FROM talentum_prescreening_responses WHERE prescreening_id = $1`,
        [psc.id],
      );
      expect(Number(before[0].cnt)).toBe(2);

      // Deleta o prescreening
      await client.query(`DELETE FROM talentum_prescreenings WHERE id = $1`, [psc.id]);

      // Respostas devem ter sido deletadas em cascade
      const { rows: after } = await client.query(
        `SELECT COUNT(*) AS cnt FROM talentum_prescreening_responses WHERE prescreening_id = $1`,
        [psc.id],
      );
      expect(Number(after[0].cnt)).toBe(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Parte 2 — POST /api/webhooks/talentum/prescreening (HTTP)
//
// Cobre Step 6 do roadmap: controller + rota + autenticação Service Account.
// Em USE_MOCK_AUTH=true, a validação do Google ID Token é bypassed.
// ═══════════════════════════════════════════════════════════════════

const DATABASE_URL_HTTP =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Talentum Webhook — POST /api/webhooks/talentum/prescreening (HTTP)', () => {
  let api: ReturnType<typeof createApiClient>;
  let pool: Pool;
  let workerFixtureId: string;     // worker com email = 'ana.webhook@test.local'
  let jobFixtureId: string;        // job_posting com title = 'Caso HTTP Test'

  const ENDPOINT = TALENTUM_WEBHOOK;

  /**
   * POST no webhook + drain da inbox (spec 095: o ack só guarda). `status` = o do ack; `data` = o que o processador
   * gravou, LIDO DO BANCO (o corpo do ack é `{ received: true }`); em ack 400, `data` é o corpo do ack.
   */
  const post = (payload: unknown) => postTalentumDrainAndRead(api, pool, payload, ENDPOINT);
  const inboxState = async (psc: string) =>
    (await pool.query<{ state: string }>(
      `SELECT state FROM talentum_webhook_inbox WHERE talentum_prescreening_id = $1 ORDER BY received_at DESC, id LIMIT 1`, [psc])).rows[0]?.state;

  // Payload base — envelope PRESCREENING_RESPONSE + data
  // BASE_DATA e envelope() vêm de tests/fixtures/talentumPayload.ts
  // (fonte única de verdade do shape, tipada contra o schema Zod).

  // Emails usados pelos testes HTTP que NÃO devem existir no worker table
  // (o fluxo assume que um POST com email desconhecido retorna workerId=null).
  // Limpamos em beforeAll e afterAll para isolar a suite de runs anteriores.
  const TRANSIENT_EMAILS = [
    'desconhecido@nowhere.test',
    'worker.analyzed@test.local',
    'outro.email@test.local',
    'analytics1@test.local',
    'analytics2@test.local',
    'analytics3@test.local',
  ];

  beforeAll(async () => {
    api = createApiClient();
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL_HTTP });

    // Limpa workers transientes que podem ter ficado de runs anteriores
    await pool.query(`DELETE FROM workers WHERE email = ANY($1)`, [TRANSIENT_EMAILS]);

    // Worker com email para testar lookup por email
    const { rows: wRows } = await pool.query(
      `INSERT INTO workers (auth_uid, email, status)
       VALUES ('webhook-http-e2e-uid', 'ana.webhook@test.local', 'INCOMPLETE_REGISTER')
       ON CONFLICT (auth_uid) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
    );
    workerFixtureId = wRows[0].id;

    // Job posting com título correspondente ao prescreening.name do payload base
    const { rows: jpRows } = await pool.query(
      `INSERT INTO job_postings (title, description, status)
       VALUES ('Caso HTTP Test', 'Job posting para testes E2E webhook', 'SEARCHING')
       RETURNING id`,
    );
    jobFixtureId = jpRows[0].id;
  });

  afterAll(async () => {
    // Remove apenas dados criados por estes testes
    await pool.query(
      `DELETE FROM talentum_prescreening_responses
       WHERE prescreening_id IN (
         SELECT id FROM talentum_prescreenings
         WHERE talentum_prescreening_id LIKE 'http-%'
       )`,
    );
    await pool.query(
      `DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE 'http-%'`,
    );
    await pool.query(
      `DELETE FROM talentum_questions WHERE question_id LIKE 'http-%'`,
    );
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [jobFixtureId]);
    await pool.query(`DELETE FROM workers WHERE auth_uid = 'webhook-http-e2e-uid'`);
    await pool.query(`DELETE FROM workers WHERE email = ANY($1)`, [TRANSIENT_EMAILS]);
    await pool.end();
  });

  afterEach(async () => {
    // Limpa prescrееnings entre testes para isolamento (mantém fixtures de worker e job)
    await pool.query(
      `DELETE FROM talentum_prescreening_responses
       WHERE prescreening_id IN (
         SELECT id FROM talentum_prescreenings
         WHERE talentum_prescreening_id LIKE 'http-%'
       )`,
    );
    await pool.query(
      `DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE 'http-%'`,
    );
    await pool.query(
      `DELETE FROM talentum_questions WHERE question_id LIKE 'http-%'`,
    );
    await pool.query(`DELETE FROM talentum_webhook_inbox WHERE talentum_prescreening_id LIKE 'http-%'`);
  });

  // ─────────────────────────────────────────────────────────────────
  // 400 — payload inválido (Zod valida antes do use case)
  // ─────────────────────────────────────────────────────────────────

  describe('400 — validação mínima do ack; o resto vira estado da inbox depois do drain', () => {
    // Zod completo saiu do ack (spec 095 §3.2): o 400 só existe para o que o ack precisa (action e ids). Cada caso de schema abaixo
    // vira "200 no ack + linha REJECTED_SCHEMA/UNSUPPORTED depois do drain"; o detalhe do schema está em unit
    // (ProcessTalentumInboxUseCase.validacao.test.ts: [7]-[12], [34]-[37]).
    it('body ausente → 400 sem "details" (o detalhe do Zod não vai mais ao ack)', async () => {
      const res = await post({});
      expect(res.status).toBe(400);
      expect(res.data).not.toHaveProperty('details');
    });

    it('subtype inválido em PRESCREENING_RESPONSE → 200 no ack e linha UNSUPPORTED depois do drain', async () => {
      const res = await post({ ...envelope({ prescreening: { id: 'http-psc-bad-subtype' } }), subtype: 'CANCELED' });
      expect(res.status).toBe(200);
      expect(res.drain).toMatchObject({ selected: 1, processed: 0, failed: 0 });
      expect(await inboxState('http-psc-bad-subtype')).toBe('UNSUPPORTED');
      expect(await readTalentumMirror(pool, 'http-psc-bad-subtype')).toBeNull();
    });

    it('email malformado em profile.email → 200 no ack e linha REJECTED_SCHEMA depois do drain', async () => {
      const res = await post(envelope({ prescreening: { id: 'http-psc-bad-email' }, profile: { email: 'nao-e-email' } }));
      expect(res.status).toBe(200);
      expect(res.drain).toMatchObject({ selected: 1, processed: 0, failed: 0 });
      expect(await inboxState('http-psc-bad-email')).toBe('REJECTED_SCHEMA');
      expect(await readTalentumMirror(pool, 'http-psc-bad-email')).toBeNull();
    });

    it('campo extra dentro de data.profile (.strict() aninhado) → 200 no ack e linha REJECTED_SCHEMA depois do drain', async () => {
      const res = await post({
        ...envelope({ prescreening: { id: 'http-psc-extra-field' } }),
        data: {
          ...envelope({ prescreening: { id: 'http-psc-extra-field' } }).data,
          profile: { ...BASE_DATA.profile, dadoExtra: true },
        },
      });
      expect(res.status).toBe(200);
      expect(res.drain).toMatchObject({ selected: 1, processed: 0, failed: 0 });
      expect(await inboxState('http-psc-extra-field')).toBe('REJECTED_SCHEMA');
    });

    it('prescreening.id vazio → 400 no ack (a chave é a validação mínima)', async () => {
      const res = await post(envelope({ prescreening: { id: '' } }));
      expect(res.status).toBe(400);
    });

    it('profile.firstName vazio → 200 no ack e linha REJECTED_SCHEMA depois do drain', async () => {
      const res = await post(envelope({ prescreening: { id: 'http-psc-empty-first' }, profile: { firstName: '' } }));
      expect(res.status).toBe(200);
      expect(res.drain).toMatchObject({ selected: 1, processed: 0, failed: 0 });
      expect(await inboxState('http-psc-empty-first')).toBe('REJECTED_SCHEMA');
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 401 — sem Authorization header (apenas fora do modo USE_MOCK_AUTH)
  // ─────────────────────────────────────────────────────────────────

  describe('401 — autenticação Google Service Account', () => {
    const isMockAuth = process.env.USE_MOCK_AUTH === 'true';

    // Em USE_MOCK_AUTH=true (todos os testes E2E locais), a validação do
    // Google ID Token é bypassed no controller — este teste só faz sentido em produção.
    it.skip('sem Authorization header → 401 (skip: USE_MOCK_AUTH=true em testes locais)', async () => {
      // Em produção (USE_MOCK_AUTH=false):
      // const res = await post(BASE_PAYLOAD); // sem header
      // expect(res.status).toBe(401);
    });

    it('token ausente com mock auth ativo → 200 (bypass de autenticação em testes)', async () => {
      if (!isMockAuth) {
        // Se por acaso rodar sem mock auth, não testamos o bypass
        return;
      }
      const res = await post(envelope({ prescreening: { id: 'http-psc-auth-bypass' } }));
      // Com USE_MOCK_AUTH=true, chega ao use case e processa normalmente
      expect(res.status).toBe(200);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 200 — happy path INITIATED (sem respostas)
  // ─────────────────────────────────────────────────────────────────

  describe('200 — INITIATED (sem respostas)', () => {
    it('retorna 200 com prescreeningId, talentumPrescreeningId e resolved', async () => {
      const res = await post(envelope({ prescreening: { id: 'http-psc-initiated-001' } }));

      expect(res.status).toBe(200);
      expect(res.data).toHaveProperty('prescreeningId');
      expect(res.data.talentumPrescreeningId).toBe('http-psc-initiated-001');
      expect(res.data).toHaveProperty('resolved');
      expect(res.data.resolved).toHaveProperty('worker');
      expect(res.data.resolved).toHaveProperty('jobPosting');
    });

    it('persiste prescreening no banco com status INITIATED', async () => {
      await post(envelope({ prescreening: { id: 'http-psc-persist-001' } }));

      const { rows } = await pool.query(
        `SELECT status, job_case_name FROM talentum_prescreenings
         WHERE talentum_prescreening_id = 'http-psc-persist-001'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('INITIATED');
      expect(rows[0].job_case_name).toBe('Caso HTTP Test');
    });

    it('sem respostas → talentum_prescreening_responses vazio para este prescreening', async () => {
      const res = await post(envelope({ prescreening: { id: 'http-psc-no-resp-001' } }));
      expect(res.status).toBe(200);

      const { rows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM talentum_prescreening_responses
         WHERE prescreening_id = $1`,
        [res.data.prescreeningId],
      );
      expect(Number(rows[0].cnt)).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 200 — lookup worker + job posting
  // ─────────────────────────────────────────────────────────────────

  describe('200 — resolução de worker e job posting', () => {
    it('worker encontrado por email → workerId preenchido, resolved.worker = true', async () => {
      // profile.email = 'ana.webhook@test.local' → workerFixtureId
      const res = await post(envelope({ prescreening: { id: 'http-psc-worker-found-001' } }));

      expect(res.status).toBe(200);
      expect(res.data.workerId).toBe(workerFixtureId);
      expect(res.data.resolved.worker).toBe(true);
    });

    it('job posting encontrado por ILIKE em title → jobPostingId preenchido, resolved.jobPosting = true', async () => {
      // prescreening.name = 'Caso HTTP Test' → job_postings.title = 'Caso HTTP Test'
      const res = await post(envelope({ prescreening: { id: 'http-psc-jp-found-001' } }));

      expect(res.status).toBe(200);
      expect(res.data.jobPostingId).toBe(jobFixtureId);
      expect(res.data.resolved.jobPosting).toBe(true);
    });

    it('worker com email desconhecido → auto-criado (workerId preenchido, resolved.worker = true)', async () => {
      // Comportamento atual: quando o worker não é encontrado por email/phone/cuil,
      // o use case auto-cria um worker INCOMPLETE_REGISTER com auth_uid=talentum_<profileId>.
      const res = await post(envelope({
        prescreening: { id: 'http-psc-no-worker-001' },
        profile: {
          email: 'desconhecido@nowhere.test',
          phoneNumber: '+5499999999',
          cuil: '99-99999999-9',
        },
      }));

      expect(res.status).toBe(200);
      expect(res.data.workerId).not.toBeNull();
      expect(res.data.resolved.worker).toBe(true);

      // Verifica que o worker auto-criado existe no banco com o email enviado
      const { rows } = await pool.query(
        `SELECT email FROM workers WHERE id = $1`,
        [res.data.workerId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].email).toBe('desconhecido@nowhere.test');
    });

    it('job posting com nome desconhecido → jobPostingId null, resolved.jobPosting = false', async () => {
      const res = await post(envelope({
        prescreening: { id: 'http-psc-no-jp-001', name: 'Caso que nao existe no sistema XYZ123' },
      }));

      expect(res.status).toBe(200);
      expect(res.data.jobPostingId).toBeNull();
      expect(res.data.resolved.jobPosting).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // 200 — fluxo incremental com respostas
  // ─────────────────────────────────────────────────────────────────

  describe('200 — fluxo incremental', () => {
    it('IN_PROGRESS com registerQuestions → persiste respostas source=register', async () => {
      const res = await post(envelope({
        subtype: 'IN_PROGRESS',
        prescreening: { id: 'http-psc-reg-001' },
        profile: {
          registerQuestions: [
            { questionId: 'http-q-reg-001', question: 'Cidade?', answer: 'Buenos Aires', responseType: 'TEXT' },
          ],
        },
      }));

      expect(res.status).toBe(200);

      const { rows } = await pool.query(
        `SELECT tpr.answer, tpr.response_source, tq.question_id
         FROM talentum_prescreening_responses tpr
         JOIN talentum_questions tq ON tq.id = tpr.question_id
         WHERE tpr.prescreening_id = $1`,
        [res.data.prescreeningId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].response_source).toBe('register');
      expect(rows[0].answer).toBe('Buenos Aires');
      expect(rows[0].question_id).toBe('http-q-reg-001');
    });

    it('IN_PROGRESS com response.state → persiste respostas source=prescreening', async () => {
      const res = await post(envelope({
        subtype: 'IN_PROGRESS',
        prescreening: { id: 'http-psc-state-001' },
        response: {
          id: 'http-resp-state-001',
          state: [
            { questionId: 'http-q-vaga-001', question: 'Tem CNH?', answer: 'Não', responseType: 'BOOLEAN' },
          ],
        },
      }));

      expect(res.status).toBe(200);

      const { rows } = await pool.query(
        `SELECT tpr.answer, tpr.response_source
         FROM talentum_prescreening_responses tpr
         JOIN talentum_questions tq ON tq.id = tpr.question_id
         WHERE tpr.prescreening_id = $1 AND tq.question_id = 'http-q-vaga-001'`,
        [res.data.prescreeningId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].response_source).toBe('prescreening');
      expect(rows[0].answer).toBe('Não');
    });

    it('3 POSTs incrementais INITIATED → IN_PROGRESS → COMPLETED: estado final correto', async () => {
      const pscExtId = 'http-psc-full-flow-001';

      // POST 1 — INITIATED, sem respostas
      const res1 = await post(envelope({ prescreening: { id: pscExtId } }));
      expect(res1.status).toBe(200);
      const pscInternalId = res1.data.prescreeningId;

      // POST 2 — IN_PROGRESS, primeira resposta
      const res2 = await post(envelope({
        subtype: 'IN_PROGRESS',
        prescreening: { id: pscExtId },
        response: {
          id: 'http-resp-full-002',
          state: [
            { questionId: 'http-q-full-001', question: 'Disponibilidade?', answer: 'Sim', responseType: 'BOOLEAN' },
          ],
        },
      }));
      expect(res2.status).toBe(200);
      // ON CONFLICT → mesmo prescreeningId interno
      expect(res2.data.prescreeningId).toBe(pscInternalId);

      // POST 3 — COMPLETED, 2 respostas acumuladas + registerQuestion
      const res3 = await post(envelope({
        subtype: 'COMPLETED',
        prescreening: { id: pscExtId },
        profile: {
          registerQuestions: [
            { questionId: 'http-q-full-reg-001', question: 'Cidade?', answer: 'Córdoba', responseType: 'TEXT' },
          ],
        },
        response: {
          id: 'http-resp-full-003',
          state: [
            { questionId: 'http-q-full-001', question: 'Disponibilidade?', answer: 'Sim', responseType: 'BOOLEAN' },
            { questionId: 'http-q-full-002', question: 'Tem veículo?', answer: 'Não', responseType: 'BOOLEAN' },
          ],
        },
      }));
      expect(res3.status).toBe(200);
      expect(res3.data.prescreeningId).toBe(pscInternalId);

      // Estado final no banco
      const { rows: pscRow } = await pool.query(
        `SELECT status FROM talentum_prescreenings WHERE id = $1`,
        [pscInternalId],
      );
      expect(pscRow[0].status).toBe('COMPLETED');

      const { rows: respRows } = await pool.query(
        `SELECT response_source FROM talentum_prescreening_responses
         WHERE prescreening_id = $1`,
        [pscInternalId],
      );
      // 2 respostas prescreening + 1 register
      expect(respRows).toHaveLength(3);
      const sources = respRows.map((r: { response_source: string }) => r.response_source);
      expect(sources.filter((s: string) => s === 'prescreening')).toHaveLength(2);
      expect(sources.filter((s: string) => s === 'register')).toHaveLength(1);
    });

    it('idempotência: mesmo payload enviado 2x → 1 registro, 200 ambas as vezes', async () => {
      const payload = envelope({ prescreening: { id: 'http-psc-idem-001' } });

      const res1 = await post(payload);
      const res2 = await post(payload);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.data.prescreeningId).toBe(res2.data.prescreeningId);

      const { rows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM talentum_prescreenings
         WHERE talentum_prescreening_id = 'http-psc-idem-001'`,
      );
      expect(Number(rows[0].cnt)).toBe(1);
    });

    it('COALESCE via endpoint: POST 1 sem job posting → null; POST 2 com job posting → resolvido', async () => {
      // POST 1: vaga com nome desconhecido → job_posting_id null
      const res1 = await post(envelope({
        prescreening: { id: 'http-psc-coalesce-jp-001', name: 'Vaga Ainda Nao Importada XYZ' },
      }));
      expect(res1.status).toBe(200);
      expect(res1.data.jobPostingId).toBeNull();
      expect(res1.data.resolved.jobPosting).toBe(false);

      // POST 2: vaga importada entre os POSTs (o título agora existe no banco)
      // Criamos o job posting diretamente no banco para simular o import tardio
      const { rows: jpNew } = await pool.query(
        `INSERT INTO job_postings (title, description, status)
         VALUES ('Vaga Ainda Nao Importada XYZ', 'Criada para simular import tardio', 'SEARCHING')
         RETURNING id`,
      );
      const newJobId = jpNew[0].id;

      try {
        const res2 = await post(envelope({
          subtype: 'IN_PROGRESS',
          prescreening: { id: 'http-psc-coalesce-jp-001', name: 'Vaga Ainda Nao Importada XYZ' },
        }));
        expect(res2.status).toBe(200);
        expect(res2.data.jobPostingId).toBe(newJobId);
        expect(res2.data.resolved.jobPosting).toBe(true);
      } finally {
        await pool.query(`DELETE FROM job_postings WHERE id = $1`, [newJobId]);
      }
    });

    it('fluxo completo COMPLETED → ANALYZED: status avança corretamente', async () => {
      const pscExtId = 'http-psc-analyzed-flow-001';

      // POST 1 — COMPLETED (worker terminou de responder)
      const res1 = await post(envelope({
        subtype: 'COMPLETED',
        prescreening: { id: pscExtId },
        response: {
          id: 'http-resp-analyzed-001',
          state: [
            { questionId: 'http-q-analyzed-001', question: 'Aprovado?', answer: 'Sim', responseType: 'BOOLEAN' },
          ],
        },
      }));
      expect(res1.status).toBe(200);
      const pscInternalId = res1.data.prescreeningId;

      // POST 2 — ANALYZED (equipe analisou o prescreening)
      const res2 = await post(envelope({
        subtype: 'ANALYZED',
        prescreening: { id: pscExtId },
        response: {
          id: 'http-resp-analyzed-002',
          state: [
            { questionId: 'http-q-analyzed-001', question: 'Aprovado?', answer: 'Sim', responseType: 'BOOLEAN' },
          ],
        },
      }));
      expect(res2.status).toBe(200);
      expect(res2.data.prescreeningId).toBe(pscInternalId);

      // Verifica status final no banco
      const { rows: pscRow } = await pool.query(
        `SELECT status FROM talentum_prescreenings WHERE id = $1`,
        [pscInternalId],
      );
      expect(pscRow[0].status).toBe('ANALYZED');
    });

    // T1 (spec 095 §3.1): a trava de ordem segura a regressão; antes deste cartão o upsert sobrescrevia (COMPLETED).
    it('status não regride: ANALYZED → COMPLETED mantém o veredito (T1)', async () => {
      const pscExtId = 'http-psc-regression-001';
      const res1 = await post(envelope({ subtype: 'COMPLETED', prescreening: { id: pscExtId } }));
      expect(res1.status).toBe(200);

      const res2 = await post(envelope({
        subtype: 'ANALYZED',
        prescreening: { id: pscExtId },
        response: { id: 'http-resp-regression-001', state: [], score: 80, statusLabel: 'QUALIFIED' } as any,
      }));
      expect(res2.status).toBe(200);
      const { rows: afterAnalyzed } = await pool.query(
        `SELECT status FROM talentum_prescreenings WHERE id = $1`,
        [res2.data.prescreeningId],
      );
      expect(afterAnalyzed[0].status).toBe('QUALIFIED');

      // POST 3: evento atrasado (COMPLETED, precedência 2 < 4) não regride o status
      const res3 = await post(envelope({ subtype: 'COMPLETED', prescreening: { id: pscExtId } }));
      expect(res3.status).toBe(200);

      const { rows: pscRow } = await pool.query(
        `SELECT status FROM talentum_prescreenings WHERE id = $1`,
        [res3.data.prescreeningId],
      );
      expect(pscRow[0].status).toBe('QUALIFIED');
    });

    // T2: empate de precedência grava o novo (veredito → veredito é reclassificação).
    it('status não regride, mas empate grava o novo: NOT_QUALIFIED → QUALIFIED (T2)', async () => {
      const pscExtId = 'http-psc-regression-tie-001';
      const res1 = await post(envelope({
        subtype: 'ANALYZED',
        prescreening: { id: pscExtId },
        response: { id: 'http-resp-tie-001', state: [], score: 30, statusLabel: 'NOT_QUALIFIED' } as any,
      }));
      expect(res1.status).toBe(200);
      const { rows: r1 } = await pool.query(`SELECT status FROM talentum_prescreenings WHERE id = $1`, [res1.data.prescreeningId]);
      expect(r1[0].status).toBe('NOT_QUALIFIED');

      const res2 = await post(envelope({
        subtype: 'ANALYZED',
        prescreening: { id: pscExtId },
        response: { id: 'http-resp-tie-001', state: [], score: 80, statusLabel: 'QUALIFIED' } as any,
      }));
      expect(res2.status).toBe(200);
      const { rows: r2 } = await pool.query(`SELECT status FROM talentum_prescreenings WHERE id = $1`, [res2.data.prescreeningId]);
      expect(r2[0].status).toBe('QUALIFIED');
    });

    // T3 (T-095-11): EXPIRED fica abaixo do veredito; o EXPIRED atrasado não o sobrescreve (veredito depois de EXPIRED vence: T12 do processador).
    it('status não regride: QUALIFIED → EXPIRED atrasado mantém o veredito (T3)', async () => {
      const pscExtId = 'http-psc-regression-expired-001';
      const res1 = await post(envelope({
        subtype: 'ANALYZED',
        prescreening: { id: pscExtId },
        response: { id: 'http-resp-expired-001', state: [], score: 80, statusLabel: 'QUALIFIED' } as any,
      }));
      expect(res1.status).toBe(200);
      const res2 = await post(envelope({
        subtype: 'ANALYZED',
        prescreening: { id: pscExtId },
        response: { id: 'http-resp-expired-001', state: [], statusLabel: 'EXPIRED' } as any,
      }));
      expect(res2.status).toBe(200);
      const { rows } = await pool.query(`SELECT status FROM talentum_prescreenings WHERE id = $1`, [res1.data.prescreeningId]);
      expect(rows[0].status).toBe('QUALIFIED');
    });

    it('query analytics: filtro por status ANALYZED retorna apenas prescreenings analisados', async () => {
      // Cria prescreenings em diferentes status
      await post(envelope({
        subtype: 'COMPLETED',
        prescreening: { id: 'http-psc-analytics-001' },
        profile: { email: 'analytics1@test.local' },
      }));

      await post(envelope({
        subtype: 'ANALYZED',
        prescreening: { id: 'http-psc-analytics-002' },
        profile: { email: 'analytics2@test.local' },
      }));

      await post(envelope({
        subtype: 'ANALYZED',
        prescreening: { id: 'http-psc-analytics-003' },
        profile: { email: 'analytics3@test.local' },
      }));

      // Query por status ANALYZED
      const { rows: analyzedRows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM talentum_prescreenings WHERE status = 'ANALYZED'`,
      );
      expect(Number(analyzedRows[0].cnt)).toBeGreaterThanOrEqual(2);

      // Query por status COMPLETED (deve excluir os ANALYZED)
      const { rows: completedRows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM talentum_prescreenings WHERE status = 'COMPLETED'`,
      );
      expect(Number(completedRows[0].cnt)).toBeGreaterThanOrEqual(1);
    });

    it('worker resolvido preserva FK via COALESCE em POSTs subsequentes com email diferente', async () => {
      // Comportamento: POST 1 auto-cria o worker (quando não existe); POST 2+ com email
      // diferente NÃO deve sobrescrever o worker_id graças ao COALESCE no upsert.
      const pscExtId = 'http-psc-worker-analyzed-001';

      // POST 1: COMPLETED, worker é auto-criado
      const res1 = await post(envelope({
        subtype: 'COMPLETED',
        prescreening: { id: pscExtId },
        profile: { email: 'worker.analyzed@test.local' },
      }));
      expect(res1.status).toBe(200);
      expect(res1.data.workerId).not.toBeNull();
      const firstWorkerId = res1.data.workerId;

      // POST 2: ANALYZED, mesmo email → mesmo workerId
      const res2 = await post(envelope({
        subtype: 'ANALYZED',
        prescreening: { id: pscExtId },
        profile: { email: 'worker.analyzed@test.local' },
      }));
      expect(res2.status).toBe(200);
      expect(res2.data.workerId).toBe(firstWorkerId);
      expect(res2.data.resolved.worker).toBe(true);

      // POST 3: ANALYZED com email DIFERENTE — COALESCE deve preservar o worker_id original
      const res3 = await post(envelope({
        subtype: 'ANALYZED',
        prescreening: { id: pscExtId },
        profile: { email: 'outro.email@test.local' },
      }));
      expect(res3.status).toBe(200);
      expect(res3.data.workerId).toBe(firstWorkerId); // COALESCE preserva
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Parte 3 — Testes de Concorrência e Confiabilidade
  // ═══════════════════════════════════════════════════════════════════

  describe('Concorrência — race conditions e idempotência', () => {
    it('upserts simultâneos do mesmo prescreening não criam duplicatas', async () => {
      const pscExtId = `http-psc-concurrent-${Date.now()}`;

      // Dispara 5 requests simultâneos com o mesmo prescreening ID
      const promises = Array.from({ length: 5 }, (_, i) =>
        post(envelope({
          subtype: 'COMPLETED',
          prescreening: { id: pscExtId },
          response: {
            id: `http-resp-concurrent-${i}`,
            state: [
              { questionId: `http-q-concurrent-${i}`, question: 'Pergunta?', answer: `Resp ${i}`, responseType: 'TEXT' },
            ],
          },
        }))
      );

      const results = await Promise.all(promises);

      // Todos devem retornar 200
      results.forEach((res) => {
        expect(res.status).toBe(200);
      });

      // Todos devem ter o mesmo prescreeningId
      const prescreeningIds = results.map((r) => r.data.prescreeningId);
      const uniqueIds = [...new Set(prescreeningIds)];
      expect(uniqueIds).toHaveLength(1);

      // Verifica que existe apenas 1 registro no banco
      const { rows } = await pool.query(
        `SELECT COUNT(*) AS cnt FROM talentum_prescreenings WHERE talentum_prescreening_id = $1`,
        [pscExtId],
      );
      expect(Number(rows[0].cnt)).toBe(1);
    });
  });
});
