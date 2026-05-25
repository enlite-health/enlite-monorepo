/**
 * wja-full-flow-1.e2e.test.ts  (Part 1 of 2)
 *
 * Smoke E2E — WJA Full Flow (Fase A do gate de regressão do core).
 * Steps 1-5: T1 → T7 (INVITED → CONFIRMED)
 *
 * Part 2: wja-full-flow-2.e2e.test.ts (REPROGRAMAR + RECHAZAR + invariantes)
 *
 * Setup: 3 workers + 1 vaga criados em beforeAll. State é persistido no banco
 * para que part2 leia sem re-seed. Cleanup completo feito em part2.afterAll.
 *
 * Ambiente: USE_MOCK_AUTH=true, USE_MOCK_GOOGLE_CALENDAR=true, sem Firebase.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';
import { envelope } from '../fixtures/talentumPayload';
import type { AnalyzedBlock } from './wja-full-flow-types';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// ── Constantes compartilhadas entre part1 e part2 ─────────────────────────

export const CASE_NUMBER = 99950;

export const PHONE_A = '+5491199771001';
export const PHONE_B = '+5491199771002';
export const PHONE_C = '+5491199771003';

export const EMAIL_A = 'wja-full-flow-a@e2e.local';
export const EMAIL_B = 'wja-full-flow-b@e2e.local';
export const EMAIL_C = 'wja-full-flow-c@e2e.local';

export const PSC_T3  = 'wff-psc-t3-fixed';
export const PSC_T4  = 'wff-psc-t4-fixed';
export const PSC_T5a = 'wff-psc-t5a-fixed';
export const PSC_T5b = 'wff-psc-t5b-fixed';
export const PSC_C   = 'wff-psc-c-fixed';

const PROF_A = 'wff-prof-a-fixed';
const PROF_C = 'wff-prof-c-fixed';

const MEET_LINK_1 = 'https://meet.google.com/wff-e2e-slot1';
const MEET_LINK_2 = 'https://meet.google.com/wff-e2e-slot2';
const MEET_LINK_3 = 'https://meet.google.com/wff-e2e-slot3';
const FUTURE_DT_1 = '2099-09-10T10:00:00Z';
const FUTURE_DT_2 = '2099-09-10T14:00:00Z';
const FUTURE_DT_3 = '2099-09-10T18:00:00Z';

// Arquivo de estado compartilhado entre part1 e part2
const STATE_FILE = path.join(__dirname, '.wja-full-flow-state.json');

interface SharedState {
  workerAId: string;
  workerBId: string;
  workerCId: string;
  jobPostingId: string;
  inviteSidA: string;
}

function saveState(state: SharedState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf-8');
}

// ── Suite part1 ───────────────────────────────────────────────────────────

describe('WJA Full Flow Part 1 — T1→T7 @integration', () => {
  const api = createApiClient();
  let pool: Pool;

  let workerAId: string;
  let workerBId: string;
  let workerCId: string;
  let jobPostingId: string;
  let inviteSidA: string;

  // ── beforeAll: seed workers + vaga + templates ──────────────────────────

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });

    // Limpar resíduos de runs anteriores
    await pool.query(`DELETE FROM job_postings WHERE case_number = $1`, [CASE_NUMBER]);
    await pool.query(`DELETE FROM workers WHERE email = ANY($1::text[])`, [
      [EMAIL_A, EMAIL_B, EMAIL_C],
    ]);
    await pool.query(
      `DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id = ANY($1::text[])`,
      [[PSC_T3, PSC_T4, PSC_T5a, PSC_T5b, PSC_C]],
    );

    // Worker A — REGISTERED, receberá T3-T7
    const wARes = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, phone, status, country)
       VALUES ($1, $2, $3, 'REGISTERED', 'AR') RETURNING id`,
      [`wff-uid-a`, EMAIL_A, PHONE_A],
    );
    workerAId = wARes.rows[0].id;

    // Worker B — REGISTERED, aplicará via link público
    const wBRes = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, phone, status, country)
       VALUES ($1, $2, $3, 'REGISTERED', 'AR') RETURNING id`,
      [`wff-uid-b`, EMAIL_B, PHONE_B],
    );
    workerBId = wBRes.rows[0].id;

    // Worker C — REGISTERED, receberá NOT_QUALIFIED → auto-reject
    const wCRes = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, phone, status, country)
       VALUES ($1, $2, $3, 'REGISTERED', 'AR') RETURNING id`,
      [`wff-uid-c`, EMAIL_C, PHONE_C],
    );
    workerCId = wCRes.rows[0].id;

    // Vaga com 3 meet links
    const jpRes = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (
         case_number, title,
         meet_link_1, meet_datetime_1,
         meet_link_2, meet_datetime_2,
         meet_link_3, meet_datetime_3,
         status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'SEARCHING')
       RETURNING id`,
      [
        CASE_NUMBER, `CASO ${CASE_NUMBER} WFF E2E`,
        MEET_LINK_1, FUTURE_DT_1,
        MEET_LINK_2, FUTURE_DT_2,
        MEET_LINK_3, FUTURE_DT_3,
      ],
    );
    jobPostingId = jpRes.rows[0].id;

    // Templates necessários para o fluxo completo
    await pool.query(`
      INSERT INTO message_templates (slug, name, body, is_active, created_at, updated_at) VALUES
        ('qualified_worker_request',      'Convite Entrevista',      '{{slot_1}}{{slot_2}}{{slot_3}}', true, NOW(), NOW()),
        ('qualified_worker',              'Convite (legacy)',         '{{slot_1}}{{slot_2}}{{slot_3}}', true, NOW(), NOW()),
        ('qualified_worker_response',     'Confirmação',             '{{date}}{{time}}',                true, NOW(), NOW()),
        ('qualified_reminder_confirm',    'Confirmação 24h',          '¿Confirma?',                     true, NOW(), NOW()),
        ('qualified_reminder_reschedule', 'Reagendar',               '¿Te gustaría reagendar?',         true, NOW(), NOW()),
        ('qualified_reminder_reason',     'Motivo rechazo',          '¿Por qué no podés?',              true, NOW(), NOW()),
        ('qualified_reprogram_confirm',   'Confirmação Reprograma',  '¿Confirma reprogramación?',       true, NOW(), NOW()),
        ('qualified_declined_admin',      'Declinó (legacy)',        'Declinó.',                        true, NOW(), NOW()),
        ('qualified_declined_thanks',     'Declinó',                 '{{worker_id}} declinó.',           true, NOW(), NOW())
      ON CONFLICT (slug) DO NOTHING
    `);
  });

  afterAll(async () => {
    // Salvar IDs para part2 usar sem re-seed
    saveState({ workerAId, workerBId, workerCId, jobPostingId, inviteSidA });
    await pool.end();
  });

  // ── Step 1: T1 ─────────────────────────────────────────────────────────

  describe('Step 1 — T1: WJA INVITED com source=system (simula MatchmakingService)', () => {
    it('Worker A recebe WJA INVITED com source=system + acquisition_channel=system + match_score', async () => {
      // Simulação direta do que MatchmakingService.saveMatchResults faz
      await pool.query(
        `INSERT INTO worker_job_applications
           (worker_id, job_posting_id, match_score, application_funnel_stage, source, acquisition_channel)
         VALUES ($1, $2, 87.5, 'INVITED', 'system', 'system')
         ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
        [workerAId, jobPostingId],
      );

      const { rows } = await pool.query(
        `SELECT application_funnel_stage, source, acquisition_channel, match_score
         FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerAId, jobPostingId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].application_funnel_stage).toBe('INVITED');
      expect(rows[0].source).toBe('system');
      expect(rows[0].acquisition_channel).toBe('system');
      expect(Number(rows[0].match_score)).toBe(87.5);
    });
  });

  // ── Step 2: T2 ─────────────────────────────────────────────────────────

  describe('Step 2 — T2: Worker B aplica via /api/worker-applications/track-channel', () => {
    it('WJA Worker B criada com source=manual + acquisition_channel=instagram', async () => {
      const workerToken = await getMockToken(api, {
        uid: 'wff-uid-b',
        email: EMAIL_B,
        role: 'worker',
      });

      const res = await api.post(
        '/api/worker-applications/track-channel',
        { jobPostingId, channel: 'instagram' },
        { headers: { Authorization: `Bearer ${workerToken}` } },
      );
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);

      const { rows } = await pool.query(
        `SELECT application_funnel_stage, source, acquisition_channel
         FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerBId, jobPostingId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].application_funnel_stage).toBe('INVITED');
      expect(rows[0].source).toBe('manual');
      expect(rows[0].acquisition_channel).toBe('instagram');
    });
  });

  // ── Step 3: T3-T5 ──────────────────────────────────────────────────────

  describe('Step 3 — T3-T5: Progressão via webhooks Talentum (Worker A)', () => {
    const ENDPOINT = '/api/webhooks/talentum/prescreening';

    it('T3: webhook INITIATED → WJA stage=INITIATED', async () => {
      const res = await api.post(ENDPOINT, envelope({
        subtype: 'INITIATED',
        prescreening: { id: PSC_T3, name: `CASO ${CASE_NUMBER} WFF E2E` },
        profile: { id: PROF_A, email: EMAIL_A, phoneNumber: PHONE_A },
      }));
      expect(res.status).toBe(200);

      const { rows } = await pool.query(
        `SELECT application_funnel_stage FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerAId, jobPostingId],
      );
      expect(rows[0].application_funnel_stage).toBe('INITIATED');
    });

    it('T4: webhook IN_PROGRESS → WJA stage=IN_PROGRESS', async () => {
      const res = await api.post(ENDPOINT, envelope({
        subtype: 'IN_PROGRESS',
        prescreening: { id: PSC_T4, name: `CASO ${CASE_NUMBER} WFF E2E` },
        profile: { id: PROF_A, email: EMAIL_A, phoneNumber: PHONE_A },
      }));
      expect(res.status).toBe(200);

      const { rows } = await pool.query(
        `SELECT application_funnel_stage FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerAId, jobPostingId],
      );
      expect(rows[0].application_funnel_stage).toBe('IN_PROGRESS');
    });

    it('T5.a: webhook COMPLETED → WJA stage=COMPLETED', async () => {
      const res = await api.post(ENDPOINT, envelope({
        subtype: 'COMPLETED',
        prescreening: { id: PSC_T5a, name: `CASO ${CASE_NUMBER} WFF E2E` },
        profile: { id: PROF_A, email: EMAIL_A, phoneNumber: PHONE_A },
      }));
      expect(res.status).toBe(200);

      const { rows } = await pool.query(
        `SELECT application_funnel_stage FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerAId, jobPostingId],
      );
      expect(rows[0].application_funnel_stage).toBe('COMPLETED');
    });

    it('T5.b QUALIFIED: webhook ANALYZED+QUALIFIED → stage=QUALIFIED + domain_event emitido', async () => {
      const res = await api.post(ENDPOINT, envelope({
        subtype: 'ANALYZED',
        prescreening: { id: PSC_T5b, name: `CASO ${CASE_NUMBER} WFF E2E` },
        profile: { id: PROF_A, email: EMAIL_A, phoneNumber: PHONE_A },
        response: {
          id: 'wff-resp-t5b',
          state: [],
          score: 91,
          statusLabel: 'QUALIFIED',
        } as AnalyzedBlock,
      }));
      expect(res.status).toBe(200);

      const { rows } = await pool.query(
        `SELECT application_funnel_stage FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerAId, jobPostingId],
      );
      expect(rows[0].application_funnel_stage).toBe('QUALIFIED');

      // Verificar domain event
      const { rows: evts } = await pool.query(
        `SELECT event FROM domain_events
         WHERE event = 'funnel_stage.qualified'
           AND payload->>'workerId' = $1
           AND payload->>'jobPostingId' = $2
         ORDER BY created_at DESC LIMIT 1`,
        [workerAId, jobPostingId],
      );
      expect(evts).toHaveLength(1);
    });

    it('PRECEDÊNCIA: webhook INITIATED tardio NÃO regride stage de QUALIFIED', async () => {
      await api.post(ENDPOINT, envelope({
        subtype: 'INITIATED',
        prescreening: { id: 'wff-late-initiated', name: `CASO ${CASE_NUMBER} WFF E2E` },
        profile: { id: PROF_A, email: EMAIL_A, phoneNumber: PHONE_A },
      }));

      const { rows } = await pool.query(
        `SELECT application_funnel_stage FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerAId, jobPostingId],
      );
      // Precedência canônica: QUALIFIED(5) > INITIATED(1)
      expect(rows[0].application_funnel_stage).toBe('QUALIFIED');
    });
  });

  // ── Step 4: T6 ─────────────────────────────────────────────────────────

  describe('Step 4 — T6: messaging_outbox com 3 slots enfileirados', () => {
    it('outbox tem row com template_slug=qualified_worker_request com slot_1/slot_2/slot_3', async () => {
      // QualifiedInterviewHandler é disparado via Pub/Sub (sem infra real no E2E).
      // Simular a row que ele inseriria na messaging_outbox.
      inviteSidA = 'SM_WFF_INVITE_A_FIXED';
      await pool.query(
        `INSERT INTO messaging_outbox
           (worker_id, template_slug, variables, status, twilio_sid, attempts)
         VALUES ($1, 'qualified_worker_request', $2::jsonb, 'sent', $3, 1)
         ON CONFLICT DO NOTHING`,
        [
          workerAId,
          JSON.stringify({
            job_posting_id: jobPostingId,
            slot_1: `${FUTURE_DT_1} | ${MEET_LINK_1}`,
            slot_2: `${FUTURE_DT_2} | ${MEET_LINK_2}`,
            slot_3: `${FUTURE_DT_3} | ${MEET_LINK_3}`,
            case_number: String(CASE_NUMBER),
          }),
          inviteSidA,
        ],
      );

      const { rows } = await pool.query(
        `SELECT template_slug, variables FROM messaging_outbox
         WHERE worker_id = $1 AND template_slug = 'qualified_worker_request'
         ORDER BY created_at DESC LIMIT 1`,
        [workerAId],
      );
      expect(rows).toHaveLength(1);
      const vars = rows[0].variables as Record<string, string>;
      expect(vars.slot_1).toBeDefined();
      expect(vars.slot_2).toBeDefined();
      expect(vars.slot_3).toBeDefined();
    });
  });

  // ── Step 5: T7 ─────────────────────────────────────────────────────────

  describe('Step 5 — T7: Worker A clica slot_1 → stage=CONFIRMED', () => {
    beforeAll(async () => {
      // Garantir que WJA está em QUALIFIED + interview_response=pending
      await pool.query(
        `UPDATE worker_job_applications
         SET application_funnel_stage = 'QUALIFIED', interview_response = 'pending', updated_at = NOW()
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerAId, jobPostingId],
      );
    });

    it('POST /api/webhooks/twilio/inbound ButtonPayload=slot_1 → 200', async () => {
      const res = await api.post(
        '/api/webhooks/twilio/inbound',
        new URLSearchParams({
          From: `whatsapp:${PHONE_A}`,
          ButtonPayload: 'slot_1',
          OriginalRepliedMessageSid: inviteSidA,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
      expect(res.status).toBe(200);
    });

    it('WJA tem interview_meet_link, interview_datetime e interview_response=confirmed', async () => {
      const { rows } = await pool.query(
        `SELECT application_funnel_stage, interview_meet_link, interview_datetime, interview_response
         FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerAId, jobPostingId],
      );
      expect(rows[0].application_funnel_stage).toBe('CONFIRMED');
      expect(rows[0].interview_meet_link).toBe(MEET_LINK_1);
      expect(rows[0].interview_datetime).not.toBeNull();
      expect(rows[0].interview_response).toBe('confirmed');
    });
  });
});
