/**
 * talentum-webhook-v2.test.ts
 *
 * Testa o webhook Talentum v2 — novo formato envelope { action, subtype, data }.
 *
 * Dois tipos de evento cobertos:
 *   - PRESCREENING.CREATED  → cria job_posting via CreateJobPostingFromTalentumUseCase
 *   - PRESCREENING_RESPONSE.* → processa prescreening via ProcessTalentumPrescreening
 *
 * Rota de teste: POST /api/webhooks-test/talentum/prescreening
 * Auth: sem X-Partner-Key (USE_MOCK_AUTH=true bypassa o middleware)
 *
 * Cenários:
 *   PRESCREENING.CREATED:
 *     1. Vaga nova     → 200, job_posting criado, talentum_project_id + title "CASO N" + status SEARCHING
 *     2. Anti-loop     → 200 com skipped:true, banco inalterado
 *     3. Payload inválido (subtype errado) → 400
 *
 *   PRESCREENING_RESPONSE:
 *     4. INITIATED     → 200, prescreening criado, worker auto-criado
 *     5. ANALYZED + QUALIFIED → 200, funnel stage atualizado, domain_event emitido
 *     6. Idempotência  → mesmo ANALYZED 2x sem duplicação
 *
 *   Validação de envelope:
 *     7. Sem action    → 400
 *     8. Sem subtype   → 400
 */

import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const ENDPOINT = '/api/webhooks-test/talentum/prescreening';

// ─────────────────────────────────────────────────────────────────
// Payload factories
// ─────────────────────────────────────────────────────────────────

function makeCreatedPayload(id: string, name = 'Vacancy Test V2') {
  return {
    action: 'PRESCREENING',
    subtype: 'CREATED',
    data: {
      _id: id,
      name,
    },
  };
}

function makeResponsePayload(
  prescreeningId: string,
  profileId: string,
  email: string,
  subtype: 'INITIATED' | 'IN_PROGRESS' | 'COMPLETED' | 'ANALYZED',
  extras: object = {},
  phoneNumber = '+5491155550000',
) {
  return {
    action: 'PRESCREENING_RESPONSE',
    subtype,
    data: {
      prescreening: {
        id: prescreeningId,
        name: `Caso V2 ${prescreeningId}`,
      },
      profile: {
        id: profileId,
        firstName: 'Worker',
        lastName: 'V2Test',
        email,
        phoneNumber,
        cuil: '20-99999001-0',
        registerQuestions: [],
      },
      response: {
        id: `resp-${prescreeningId}`,
        state: [],
        ...extras,
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// Suite principal
// ─────────────────────────────────────────────────────────────────

describe('Talentum Webhook v2 — envelope { action, subtype, data }', () => {
  const api = createApiClient();
  let pool: Pool;

  // IDs de fixtures usados ao longo da suite
  const PROJECT_ID_NEW   = 'tw2-project-new-001';
  const PROJECT_ID_EXIST = 'tw2-project-exist-001';

  const PRESCREENING_ID_INITIATED  = 'tw2-psc-initiated-001';
  const PRESCREENING_ID_ANALYZED   = 'tw2-psc-analyzed-001';
  const PRESCREENING_ID_IDEM       = 'tw2-psc-idem-001';

  const PROFILE_ID_INITIATED  = 'tw2-prof-initiated-001';
  const PROFILE_ID_ANALYZED   = 'tw2-prof-analyzed-001';
  const PROFILE_ID_IDEM       = 'tw2-prof-idem-001';

  const EMAIL_INITIATED = 'tw2.initiated@e2e.local';
  const EMAIL_ANALYZED  = 'tw2.analyzed@e2e.local';
  const EMAIL_IDEM      = 'tw2.idem@e2e.local';

  // job_posting criado pelo cenário "vaga nova" — salvo para cleanup
  let createdJobPostingId: string | undefined;

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });

    // Garantir que job_posting com talentum_project_id=PROJECT_ID_EXIST exista para o teste de anti-loop
    const existing = await pool.query<{ id: string }>(
      'SELECT id FROM job_postings WHERE talentum_project_id = $1',
      [PROJECT_ID_EXIST],
    );
    if (existing.rows.length === 0) {
      await pool.query(
        `INSERT INTO job_postings (title, description, status, country, talentum_project_id, case_number)
         VALUES ('CASO 9901', '', 'SEARCHING', 'AR', $1, 9901)`,
        [PROJECT_ID_EXIST],
      );
    }
  });

  afterAll(async () => {
    // Cleanup reverso respeitando FKs

    // domain_events criados pelo fluxo QUALIFIED
    await pool.query(
      `DELETE FROM domain_events WHERE payload->>'workerId' IN (
        SELECT id FROM workers WHERE email IN ($1, $2, $3)
      )`,
      [EMAIL_INITIATED, EMAIL_ANALYZED, EMAIL_IDEM],
    ).catch(() => {});

    // encuadres
    await pool.query(
      `DELETE FROM encuadres WHERE worker_id IN (
        SELECT id FROM workers WHERE email IN ($1, $2, $3)
      )`,
      [EMAIL_INITIATED, EMAIL_ANALYZED, EMAIL_IDEM],
    ).catch(() => {});

    // worker_job_applications
    await pool.query(
      `DELETE FROM worker_job_applications WHERE worker_id IN (
        SELECT id FROM workers WHERE email IN ($1, $2, $3)
      )`,
      [EMAIL_INITIATED, EMAIL_ANALYZED, EMAIL_IDEM],
    ).catch(() => {});

    // talentum_prescreening_responses
    await pool.query(
      `DELETE FROM talentum_prescreening_responses WHERE prescreening_id IN (
        SELECT id FROM talentum_prescreenings
        WHERE talentum_prescreening_id IN ($1, $2, $3)
      )`,
      [PRESCREENING_ID_INITIATED, PRESCREENING_ID_ANALYZED, PRESCREENING_ID_IDEM],
    ).catch(() => {});

    // talentum_prescreenings
    await pool.query(
      `DELETE FROM talentum_prescreenings
       WHERE talentum_prescreening_id IN ($1, $2, $3)`,
      [PRESCREENING_ID_INITIATED, PRESCREENING_ID_ANALYZED, PRESCREENING_ID_IDEM],
    ).catch(() => {});

    // workers auto-criados
    await pool.query(
      `DELETE FROM workers WHERE email IN ($1, $2, $3)`,
      [EMAIL_INITIATED, EMAIL_ANALYZED, EMAIL_IDEM],
    ).catch(() => {});

    // job_postings criados por este teste
    if (createdJobPostingId) {
      await pool.query('DELETE FROM job_postings WHERE id = $1', [createdJobPostingId]).catch(() => {});
    }
    await pool.query(
      'DELETE FROM job_postings WHERE talentum_project_id = $1',
      [PROJECT_ID_NEW],
    ).catch(() => {});
    await pool.query(
      'DELETE FROM job_postings WHERE talentum_project_id = $1',
      [PROJECT_ID_EXIST],
    ).catch(() => {});

    await pool.end();
  });

  afterEach(async () => {
    // Sem truncate global — cada teste usa IDs únicos; cleanup granular em afterAll
  });

  // ═══════════════════════════════════════════════════════════════════
  // Bloco A — PRESCREENING.CREATED
  // ═══════════════════════════════════════════════════════════════════

  describe('PRESCREENING.CREATED', () => {
    // ── Cenário 1 — Vaga nova ─────────────────────────────────────
    it('1. vaga nova → 200, job_posting criado com title CASO N, status SEARCHING', async () => {
      const payload = makeCreatedPayload(PROJECT_ID_NEW, 'Novo Projeto Talentum V2');

      const res = await api.post(ENDPOINT, payload);

      expect(res.status).toBe(200);
      expect(res.data.received).toBe(true);
      expect(res.data.event).toBe('PRESCREENING.CREATED');
      expect(res.data.created).toBe(true);
      expect(res.data.skipped).toBe(false);
      expect(res.data.jobPostingId).toBeTruthy();

      createdJobPostingId = res.data.jobPostingId as string;

      // Verificar no banco
      const { rows } = await pool.query<{
        id: string;
        title: string;
        status: string;
        talentum_project_id: string;
        case_number: number | null;
        vacancy_number: number;
      }>(
        `SELECT id, title, status, talentum_project_id, case_number, vacancy_number
         FROM job_postings WHERE talentum_project_id = $1`,
        [PROJECT_ID_NEW],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('SEARCHING');
      expect(rows[0].talentum_project_id).toBe(PROJECT_ID_NEW);
      // Título auto-gerado: "CASO N-V" se o nome contém "CASO N", senão "VACANTE V"
      expect(rows[0].title).toMatch(/^(CASO \d+-\d+|VACANTE \d+)$/);
      // vacancy_number sempre preenchido; case_number só preenchido quando nome contém "CASO N"
      expect(rows[0].vacancy_number ?? rows[0].case_number).not.toBeNull();
    });

    // ── Cenário 2 — Anti-loop (vaga já existe) ────────────────────
    it('2. anti-loop — talentum_project_id já existe → 200 com skipped:true, banco inalterado', async () => {
      // Verificar contagem antes
      const { rows: before } = await pool.query<{ cnt: string }>(
        'SELECT COUNT(*) AS cnt FROM job_postings WHERE talentum_project_id = $1',
        [PROJECT_ID_EXIST],
      );
      const countBefore = Number(before[0].cnt);

      const payload = makeCreatedPayload(PROJECT_ID_EXIST, 'Vaga Duplicada');
      const res = await api.post(ENDPOINT, payload);

      expect(res.status).toBe(200);
      expect(res.data.skipped).toBe(true);
      expect(res.data.created).toBe(false);
      expect(res.data.reason).toBe('already_exists');

      // Banco inalterado
      const { rows: after } = await pool.query<{ cnt: string }>(
        'SELECT COUNT(*) AS cnt FROM job_postings WHERE talentum_project_id = $1',
        [PROJECT_ID_EXIST],
      );
      expect(Number(after[0].cnt)).toBe(countBefore);
    });

    // ── Cenário 3 — Payload inválido (subtype errado) ─────────────
    it('3. payload inválido — action=PRESCREENING + subtype=ANALYZED (discriminated union inválida) → 400', async () => {
      const payload = {
        action: 'PRESCREENING',
        subtype: 'ANALYZED', // inválido: PRESCREENING só aceita CREATED
        data: {
          _id: 'will-not-be-created',
          name: 'Should Fail',
        },
      };

      const res = await api.post(ENDPOINT, payload);

      expect(res.status).toBe(400);
      expect(res.data.error).toBe('Invalid payload');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Bloco B — PRESCREENING_RESPONSE
  // ═══════════════════════════════════════════════════════════════════

  describe('PRESCREENING_RESPONSE', () => {
    // ── Cenário 4 — INITIATED ─────────────────────────────────────
    it('4. INITIATED → 200, prescreening criado, worker auto-criado (INCOMPLETE_REGISTER)', async () => {
      const payload = makeResponsePayload(
        PRESCREENING_ID_INITIATED,
        PROFILE_ID_INITIATED,
        EMAIL_INITIATED,
        'INITIATED',
      );

      const res = await api.post(ENDPOINT, payload);

      expect(res.status).toBe(200);
      // O endpoint webhooks-test roda com dryRun=false (test environment, não dryRun)
      // Result deve conter talentumPrescreeningId
      expect(res.data.talentumPrescreeningId).toBe(PRESCREENING_ID_INITIATED);

      // Verificar prescreening no banco
      const { rows: pscRows } = await pool.query<{
        id: string;
        status: string;
        worker_id: string | null;
      }>(
        `SELECT id, status, worker_id
         FROM talentum_prescreenings
         WHERE talentum_prescreening_id = $1`,
        [PRESCREENING_ID_INITIATED],
      );

      expect(pscRows).toHaveLength(1);
      expect(pscRows[0].status).toBe('INITIATED');

      // Worker deve ter sido auto-criado
      const { rows: workerRows } = await pool.query<{
        id: string;
        status: string;
        email: string;
      }>(
        `SELECT id, status, email FROM workers WHERE email = $1`,
        [EMAIL_INITIATED],
      );
      expect(workerRows).toHaveLength(1);
      expect(workerRows[0].status).toBe('INCOMPLETE_REGISTER');

      // prescreening.worker_id deve estar preenchido (auto-created worker)
      expect(pscRows[0].worker_id).toBe(workerRows[0].id);
    });

    // ── Cenário 5 — ANALYZED + QUALIFIED ─────────────────────────
    it('5. ANALYZED + QUALIFIED → 200, application_funnel_stage=QUALIFIED, domain_event emitido', async () => {
      // Primeiro enviar INITIATED para criar worker + prescreening
      const initiatedPayload = makeResponsePayload(
        PRESCREENING_ID_ANALYZED,
        PROFILE_ID_ANALYZED,
        EMAIL_ANALYZED,
        'INITIATED',
        {},
        // Mesmo telefone do ANALYZED abaixo: o webhook agora acha worker pelo telefone (com/sem o 9), e um
        // telefone compartilhado com o cenário 4 amarrava a prescreening ao worker de outra pessoa.
        '+5491155550001',
      );
      const initRes = await api.post(ENDPOINT, initiatedPayload);
      expect(initRes.status).toBe(200);

      // Buscar o job_posting criado no cenário 1 para montar o titulo que o UseCase vai fazer ILIKE
      // O prescreening.name precisa dar match com o titulo do job_posting
      // Aqui não temos um job_posting com esse nome, então job_posting_id será null
      // O test de QUALIFIED requer que worker + job_posting existam para emitir evento
      // Vamos usar o job_posting criado no cenário 1 (talentum_project_id = PROJECT_ID_NEW)
      // e ajustar o prescreening.name para fazer ILIKE match

      // Buscar o job_posting criado pelo cenário 1
      expect(createdJobPostingId).toBeTruthy();
      const { rows: jpRows } = await pool.query<{ title: string }>(
        'SELECT title FROM job_postings WHERE id = $1',
        [createdJobPostingId],
      );
      const jobTitle = jpRows[0]?.title ?? 'CASO 1';

      // Enviar ANALYZED com prescreening.name = título do job_posting (para resolver FK)
      const analyzedPayload = {
        action: 'PRESCREENING_RESPONSE',
        subtype: 'ANALYZED',
        data: {
          prescreening: {
            id: PRESCREENING_ID_ANALYZED,
            name: jobTitle, // ILIKE match garante job_posting_id preenchido
          },
          profile: {
            id: PROFILE_ID_ANALYZED,
            firstName: 'Worker',
            lastName: 'V2Test',
            email: EMAIL_ANALYZED,
            phoneNumber: '+5491155550001',
            cuil: '20-99999002-0',
            registerQuestions: [],
          },
          response: {
            id: `resp-${PRESCREENING_ID_ANALYZED}`,
            state: [],
            score: 87,
            statusLabel: 'QUALIFIED',
          },
        },
      };

      const res = await api.post(ENDPOINT, analyzedPayload);
      expect(res.status).toBe(200);
      expect(res.data.talentumPrescreeningId).toBe(PRESCREENING_ID_ANALYZED);

      // Worker deve existir
      const { rows: workerRows } = await pool.query<{ id: string }>(
        'SELECT id FROM workers WHERE email = $1',
        [EMAIL_ANALYZED],
      );
      expect(workerRows).toHaveLength(1);
      const workerId = workerRows[0].id;

      // worker_job_applications deve ter funnel_stage = QUALIFIED
      const { rows: appRows } = await pool.query<{
        application_funnel_stage: string;
      }>(
        `SELECT application_funnel_stage
         FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerId, createdJobPostingId],
      );

      expect(appRows).toHaveLength(1);
      expect(appRows[0].application_funnel_stage).toBe('QUALIFIED');

      // domain_event funnel_stage.qualified deve ter sido emitido
      const { rows: eventRows } = await pool.query<{
        event: string;
        payload: { workerId: string; jobPostingId: string };
      }>(
        `SELECT event, payload FROM domain_events
         WHERE event = 'funnel_stage.qualified'
           AND payload->>'workerId' = $1
           AND payload->>'jobPostingId' = $2`,
        [workerId, createdJobPostingId],
      );
      expect(eventRows.length).toBeGreaterThanOrEqual(1);
      expect(eventRows[0].event).toBe('funnel_stage.qualified');
    });

    // ── Cenário 6 — Idempotência ANALYZED ────────────────────────
    it('6. idempotência — mesmo payload ANALYZED enviado 2x → sem duplicação no banco', async () => {
      // Iniciar prescreening
      const initiatedPayload = makeResponsePayload(
        PRESCREENING_ID_IDEM,
        PROFILE_ID_IDEM,
        EMAIL_IDEM,
        'INITIATED',
      );
      const initRes = await api.post(ENDPOINT, initiatedPayload);
      expect(initRes.status).toBe(200);

      const analyzedPayload = {
        action: 'PRESCREENING_RESPONSE',
        subtype: 'ANALYZED',
        data: {
          prescreening: {
            id: PRESCREENING_ID_IDEM,
            name: `Caso V2 ${PRESCREENING_ID_IDEM}`,
          },
          profile: {
            id: PROFILE_ID_IDEM,
            firstName: 'Worker',
            lastName: 'V2Test',
            email: EMAIL_IDEM,
            phoneNumber: '+5491155550002',
            cuil: '20-99999003-0',
            registerQuestions: [],
          },
          response: {
            id: `resp-${PRESCREENING_ID_IDEM}`,
            state: [],
            score: 72,
            statusLabel: 'QUALIFIED',
          },
        },
      };

      // Enviar 2x
      const res1 = await api.post(ENDPOINT, analyzedPayload);
      const res2 = await api.post(ENDPOINT, analyzedPayload);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      // talentum_prescreenings: apenas 1 registro
      const { rows: pscRows } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM talentum_prescreenings
         WHERE talentum_prescreening_id = $1`,
        [PRESCREENING_ID_IDEM],
      );
      expect(Number(pscRows[0].cnt)).toBe(1);

      // worker auto-criado: apenas 1
      const { rows: workerRows } = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM workers WHERE email = $1`,
        [EMAIL_IDEM],
      );
      expect(Number(workerRows[0].cnt)).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Bloco C — Validação de envelope
  // ═══════════════════════════════════════════════════════════════════

  describe('Validação de envelope', () => {
    // ── Cenário 7 — Sem action ────────────────────────────────────
    it('7. sem action → 400', async () => {
      const res = await api.post(ENDPOINT, {
        subtype: 'CREATED',
        data: { _id: 'x', name: 'y' },
      });

      expect(res.status).toBe(400);
      expect(res.data.error).toBe('Invalid payload');
    });

    // ── Cenário 8 — Sem subtype ───────────────────────────────────
    it('8. sem subtype → 400', async () => {
      const res = await api.post(ENDPOINT, {
        action: 'PRESCREENING',
        data: { _id: 'x', name: 'y' },
      });

      expect(res.status).toBe(400);
      expect(res.data.error).toBe('Invalid payload');
    });

    // ── Cenário extra — action desconhecida ───────────────────────
    it('action desconhecida (fora da discriminated union) → 400', async () => {
      const res = await api.post(ENDPOINT, {
        action: 'UNKNOWN_ACTION',
        subtype: 'CREATED',
        data: {},
      });

      expect(res.status).toBe(400);
      expect(res.data.error).toBe('Invalid payload');
    });

    // ── Cenário extra — body vazio ────────────────────────────────
    it('body vazio → 400', async () => {
      const res = await api.post(ENDPOINT, {});

      expect(res.status).toBe(400);
      expect(res.data.error).toBe('Invalid payload');
    });
  });
});
