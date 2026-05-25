/**
 * wja-full-flow-2.e2e.test.ts  (Part 2 of 2)
 *
 * Smoke E2E — WJA Full Flow (Fase A do gate de regressão do core).
 * Steps 6-9: REPROGRAMAR + RECHAZAR (auto + manual) + invariantes.
 *
 * Depende do estado deixado no banco por wja-full-flow-1.e2e.test.ts (Part 1).
 * Lê IDs do arquivo de estado .wja-full-flow-state.json gerado por part1.
 * Faz o cleanup completo de TODOS os dados no afterAll.
 *
 * Ambiente: USE_MOCK_AUTH=true, USE_MOCK_GOOGLE_CALENDAR=true, sem Firebase.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';
import { envelope } from '../fixtures/talentumPayload';
import type { AnalyzedBlock } from './wja-full-flow-types';
import {
  CASE_NUMBER, PHONE_A, PHONE_B, PHONE_C,
  EMAIL_A, EMAIL_B, EMAIL_C,
  PSC_T3, PSC_T4, PSC_T5a, PSC_T5b, PSC_C,
} from './wja-full-flow-1.e2e.test';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const STATE_FILE = path.join(__dirname, '.wja-full-flow-state.json');

interface SharedState {
  workerAId: string;
  workerBId: string;
  workerCId: string;
  jobPostingId: string;
  inviteSidA: string;
}

function loadState(): SharedState {
  const raw = fs.readFileSync(STATE_FILE, 'utf-8');
  return JSON.parse(raw) as SharedState;
}

const PROF_C = 'wff-prof-c-fixed';

// ── Suite part2 ───────────────────────────────────────────────────────────

describe('WJA Full Flow Part 2 — REPROGRAMAR + RECHAZAR + Invariantes @integration', () => {
  const api = createApiClient();
  let pool: Pool;

  let workerAId: string;
  let workerBId: string;
  let workerCId: string;
  let jobPostingId: string;

  let reprogramReminderSid: string;
  let reprogramRescheduleSid: string;

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });

    // Carregar IDs persistidos por part1
    const state = loadState();
    workerAId    = state.workerAId;
    workerBId    = state.workerBId;
    workerCId    = state.workerCId;
    jobPostingId = state.jobPostingId;
  });

  afterAll(async () => {
    if (!pool) return;

    // Cleanup completo de todos os dados do smoke E2E
    const workerIds = [workerAId, workerBId, workerCId].filter(Boolean);

    await pool.query(
      `DELETE FROM messaging_outbox WHERE worker_id = ANY($1::uuid[])`,
      [workerIds],
    );
    await pool.query(
      `DELETE FROM domain_events
       WHERE payload->>'workerId' = ANY($1::text[])
          OR payload->>'jobPostingId' = $2`,
      [workerIds.map(String), jobPostingId],
    );
    await pool.query(
      `DELETE FROM worker_job_application_stage_history
       WHERE application_id IN (
         SELECT id FROM worker_job_applications WHERE worker_id = ANY($1::uuid[])
       )`,
      [workerIds],
    );
    await pool.query(
      `DELETE FROM talentum_prescreening_responses
       WHERE prescreening_id IN (
         SELECT id FROM talentum_prescreenings
         WHERE talentum_prescreening_id = ANY($1::text[])
       )`,
      [[PSC_T3, PSC_T4, PSC_T5a, PSC_T5b, PSC_C, 'wff-late-initiated']],
    );
    await pool.query(
      `DELETE FROM talentum_prescreenings
       WHERE talentum_prescreening_id = ANY($1::text[])`,
      [[PSC_T3, PSC_T4, PSC_T5a, PSC_T5b, PSC_C, 'wff-late-initiated']],
    );
    await pool.query(
      `DELETE FROM worker_job_applications WHERE worker_id = ANY($1::uuid[])`,
      [workerIds],
    );
    await pool.query(
      `DELETE FROM encuadres WHERE worker_id = ANY($1::uuid[])`,
      [workerIds],
    );
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [jobPostingId]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [workerIds]);

    // Remover arquivo de estado
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);

    await pool.end();
  });

  // ── Step 6: REPROGRAMAR ───────────────────────────────────────────────────

  describe('Step 6 — REPROGRAMAR: Worker A pede reschedule (F7.b)', () => {
    beforeAll(async () => {
      // Simular reminder com SID para correlação
      reprogramReminderSid = 'SM_WFF_REMINDER_A_P2';
      await pool.query(
        `INSERT INTO messaging_outbox
           (worker_id, template_slug, variables, status, twilio_sid, attempts)
         VALUES ($1, 'qualified_reminder_confirm', $2::jsonb, 'sent', $3, 1)`,
        [workerAId, JSON.stringify({ job_posting_id: jobPostingId }), reprogramReminderSid],
      );
    });

    it('confirm_no → interview_response=awaiting_reschedule, funnel_stage permanece CONFIRMED', async () => {
      const res = await api.post(
        '/api/webhooks/twilio/inbound',
        new URLSearchParams({
          From: `whatsapp:${PHONE_A}`,
          ButtonPayload: 'confirm_no',
          OriginalRepliedMessageSid: reprogramReminderSid,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
      expect(res.status).toBe(200);

      const { rows } = await pool.query(
        `SELECT application_funnel_stage, interview_response
         FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerAId, jobPostingId],
      );
      expect(rows[0].interview_response).toBe('awaiting_reschedule');
      // F7.b: permanece CONFIRMED (não existe REPROGRAM no schema)
      expect(rows[0].application_funnel_stage).toBe('CONFIRMED');
    });

    it('reschedule_yes → meet_link=NULL + interview_response=awaiting_reschedule (self-loop F7.b)', async () => {
      // Atribuir SID ao outbox de reschedule gerado pelo confirm_no
      reprogramRescheduleSid = 'SM_WFF_RESCHED_A_P2';
      await pool.query(
        `UPDATE messaging_outbox SET twilio_sid = $1
         WHERE worker_id = $2 AND template_slug = 'qualified_reminder_reschedule'
           AND twilio_sid IS NULL`,
        [reprogramRescheduleSid, workerAId],
      );

      const res = await api.post(
        '/api/webhooks/twilio/inbound',
        new URLSearchParams({
          From: `whatsapp:${PHONE_A}`,
          ButtonPayload: 'reschedule_yes',
          OriginalRepliedMessageSid: reprogramRescheduleSid,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
      expect(res.status).toBe(200);

      const { rows } = await pool.query(
        `SELECT application_funnel_stage, interview_response,
                interview_meet_link, interview_datetime
         FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerAId, jobPostingId],
      );
      // ADR-003 F7.b: REPROGRAM removido — fica CONFIRMED+awaiting_reschedule+meet_link=NULL
      expect(rows[0].application_funnel_stage).toBe('CONFIRMED');
      expect(rows[0].interview_response).toBe('awaiting_reschedule');
      expect(rows[0].interview_meet_link).toBeNull();
      expect(rows[0].interview_datetime).toBeNull();
    });

    it('WJA continua em CONFIRMED (estado REPROGRAM não existe no schema)', async () => {
      const { rows } = await pool.query(
        `SELECT application_funnel_stage FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerAId, jobPostingId],
      );
      expect(rows[0].application_funnel_stage).not.toBe('REPROGRAM');
      expect(rows[0].application_funnel_stage).toBe('CONFIRMED');
    });
  });

  // ── Step 7: RECHAZAR auto — Worker C com NOT_QUALIFIED ────────────────────

  describe('Step 7 — RECHAZAR auto: Worker C recebe NOT_QUALIFIED → REJECTED', () => {
    it('webhook ANALYZED+NOT_QUALIFIED → WJA Worker C stage=REJECTED (F3 auto-reject)', async () => {
      // Worker C ainda não tem WJA — primeiro precisa de um INITIATED pra criar a linha.
      // O fluxo Talentum real envia INITIATED → IN_PROGRESS → COMPLETED → ANALYZED.
      // Pulamos pra INITIATED + ANALYZED direto pra brevidade.
      const initRes = await api.post('/api/webhooks/talentum/prescreening', envelope({
        subtype: 'INITIATED',
        prescreening: { id: 'wff-psc-c-init', name: `CASO ${CASE_NUMBER} WFF E2E` },
        profile: { id: PROF_C, email: EMAIL_C, phoneNumber: PHONE_C },
      }));
      expect(initRes.status).toBe(200);

      const res = await api.post(
        '/api/webhooks/talentum/prescreening',
        envelope({
          subtype: 'ANALYZED',
          prescreening: { id: PSC_C, name: `CASO ${CASE_NUMBER} WFF E2E` },
          profile: { id: PROF_C, email: EMAIL_C, phoneNumber: PHONE_C },
          response: {
            id: 'wff-resp-c',
            state: [],
            score: 30,
            statusLabel: 'NOT_QUALIFIED',
          } as AnalyzedBlock,
        }),
      );
      expect(res.status).toBe(200);

      // NOT_QUALIFIED nunca persiste — auto-rejeitado para REJECTED na mesma transação
      const { rows } = await pool.query(
        `SELECT application_funnel_stage FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerCId, jobPostingId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].application_funnel_stage).toBe('REJECTED');
    });

    it('encuadres.resultado=RECHAZADO + rejection_reason_category=TALENTUM_NOT_QUALIFIED', async () => {
      const { rows } = await pool.query(
        `SELECT resultado, rejection_reason_category
         FROM encuadres
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerCId, jobPostingId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].resultado).toBe('RECHAZADO');
      expect(rows[0].rejection_reason_category).toBe('TALENTUM_NOT_QUALIFIED');
    });
  });

  // ── Step 8: RECHAZAR manual — admin arrasta Worker B ─────────────────────

  describe('Step 8 — RECHAZAR manual: admin move Worker B → REJECTED', () => {
    let encuadreBId: string;
    let adminToken: string;

    beforeAll(async () => {
      adminToken = await getMockToken(api, {
        uid: 'wff-admin-uid',
        email: 'wff-admin@e2e.local',
        role: 'admin',
      });

      // Trigger 189 deve ter criado encuadre para Worker B ao inserir WJA (Step 2)
      const { rows } = await pool.query(
        `SELECT id FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2 LIMIT 1`,
        [workerBId, jobPostingId],
      );
      expect(rows).toHaveLength(1);
      encuadreBId = rows[0].id;
    });

    it('PUT /api/admin/encuadres/:id/move com targetStage=REJECTED → WJA stage=REJECTED', async () => {
      // F4: frontend envia apenas rejectionReasonCategory (texto categorizado).
      // rejection_reason (legado, enum 3-valores: other/incompatible_schedule/distance) NÃO é
      // exposto pra texto livre na UI — schema precisa virar TEXT no futuro pra suportar (TD).
      const res = await api.put(
        `/api/admin/encuadres/${encuadreBId}/move`,
        {
          targetStage: 'REJECTED',
          rejectionReasonCategory: 'WORKER_DECLINED',
        },
        { headers: { Authorization: `Bearer ${adminToken}` } },
      );
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);

      const { rows } = await pool.query(
        `SELECT application_funnel_stage FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerBId, jobPostingId],
      );
      expect(rows[0].application_funnel_stage).toBe('REJECTED');
    });

    it('encuadres.resultado=RECHAZADO + rejection_reason_category preenchido', async () => {
      const { rows } = await pool.query(
        `SELECT resultado, rejection_reason_category FROM encuadres WHERE id = $1`,
        [encuadreBId],
      );
      expect(rows[0].resultado).toBe('RECHAZADO');
      expect(rows[0].rejection_reason_category).toBe('WORKER_DECLINED');
    });
  });

  // ── Step 9: Invariantes finais ────────────────────────────────────────────

  describe('Step 9 — Invariantes finais', () => {
    it('CARDINALIDADE: segundo INSERT do mesmo par (workerA, vaga) é no-op idempotente', async () => {
      // Tentativa de inserir duplicata — deve ser no-op via ON CONFLICT DO NOTHING
      await pool.query(
        `INSERT INTO worker_job_applications
           (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, 'INVITED', 'system')
         ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
        [workerAId, jobPostingId],
      );

      // Deve continuar existindo exatamente 1 row
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [workerAId, jobPostingId],
      );
      expect(rows[0].cnt).toBe(1);
    });

    it('Stage history: transições de Worker A foram registradas em stage_history', async () => {
      // Worker A passou por: INVITED → INITIATED → IN_PROGRESS → COMPLETED → QUALIFIED → CONFIRMED
      const { rows } = await pool.query(
        `SELECT sh.old_value, sh.new_value
         FROM worker_job_application_stage_history sh
         JOIN worker_job_applications wja ON wja.id = sh.application_id
         WHERE wja.worker_id = $1 AND wja.job_posting_id = $2
         ORDER BY sh.created_at ASC`,
        [workerAId, jobPostingId],
      );
      expect(rows.length).toBeGreaterThanOrEqual(5);

      const stages = rows.map(r => r.new_value as string);
      expect(stages).toContain('INITIATED');
      expect(stages).toContain('IN_PROGRESS');
      expect(stages).toContain('COMPLETED');
      expect(stages).toContain('QUALIFIED');
      expect(stages).toContain('CONFIRMED');
    });

    it('Encuadres: trigger 189 criou 1 encuadre por WJA (3 workers = 3 encuadres)', async () => {
      const { rows } = await pool.query(
        `SELECT worker_id FROM encuadres
         WHERE job_posting_id = $1 AND worker_id = ANY($2::uuid[])`,
        [jobPostingId, [workerAId, workerBId, workerCId]],
      );
      expect(rows.length).toBe(3);
    });
  });
});
