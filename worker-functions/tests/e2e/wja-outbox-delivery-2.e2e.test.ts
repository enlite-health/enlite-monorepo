/**
 * wja-outbox-delivery-2.e2e.test.ts  (Fase C do gate de regressão WJA — Part 2 de 2)
 *
 * Continua de wja-outbox-delivery-1.e2e.test.ts que criou workers + vagas.
 * Lê IDs do arquivo de estado .wja-outbox-delivery-state.json.
 * Faz o cleanup completo de todos os dados no afterAll.
 *
 * Cenários:
 *   Step 4 — T6 slots parciais: vaga com 1 meet link → slot_2/slot_3 repetem o slot_1
 *              (variável vazia é rejeitada pela Meta — causa do outage do convite)
 *   Step 5 — T7 slot sem link: slot_2 inexistente → fallback agenda o primeiro slot futuro
 */

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { envelope } from '../fixtures/talentumPayload';
import type { AnalyzedBlock } from './wja-full-flow-types';
import {
  OD_CASE_2,
  OD_PHONE_2,
  OD_EMAIL_2,
  OD_ML_1,
  OD_PSC,
} from './wja-outbox-delivery-1.e2e.test';

const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';
const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const STATE_FILE = path.join(__dirname, '.wja-outbox-delivery-state.json');

interface OdState {
  worker1Id: string;
  worker2Id: string;
  job1Id: string;
  job2Id: string;
}

function loadState(): OdState {
  const raw = fs.readFileSync(STATE_FILE, 'utf-8');
  return JSON.parse(raw) as OdState;
}

// ── Suite Part 2 ──────────────────────────────────────────────────────────────

describe('WJA Outbox Delivery Part 2 — T6 Slots Parciais + T7 Invalid Slot @integration', () => {
  const api = createApiClient();
  let pool: Pool;

  let worker1Id: string;
  let worker2Id: string;
  let job1Id: string;
  let job2Id: string;

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });

    const state = loadState();
    worker1Id = state.worker1Id;
    worker2Id = state.worker2Id;
    job1Id    = state.job1Id;
    job2Id    = state.job2Id;
  });

  // ── afterAll: cleanup COMPLETO de todos os dados das parts 1 e 2 ──────────

  afterAll(async () => {
    if (!pool) return;

    const wids = [worker1Id, worker2Id].filter(Boolean);
    const jids = [job1Id, job2Id].filter(Boolean);
    const pscIds = Object.values(OD_PSC);

    await pool.query(`DELETE FROM messaging_outbox WHERE worker_id = ANY($1::uuid[])`, [wids]);
    await pool.query(
      `DELETE FROM domain_events
       WHERE payload->>'workerId' = ANY($1::text[])
          OR payload->>'jobPostingId' = ANY($2::text[])`,
      [wids.map(String), jids.map(String)],
    );
    await pool.query(
      `DELETE FROM worker_job_application_stage_history
       WHERE application_id IN (
         SELECT id FROM worker_job_applications WHERE worker_id = ANY($1::uuid[])
       )`,
      [wids],
    );
    await pool.query(
      `DELETE FROM talentum_prescreening_responses
       WHERE prescreening_id IN (
         SELECT id FROM talentum_prescreenings
         WHERE talentum_prescreening_id = ANY($1::text[])
       )`,
      [pscIds],
    );
    await pool.query(
      `DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id = ANY($1::text[])`,
      [pscIds],
    );
    await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = ANY($1::uuid[])`, [wids]);
    await pool.query(`DELETE FROM encuadres WHERE worker_id = ANY($1::uuid[])`, [wids]);
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [jids]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [wids]);

    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);

    await pool.end();
  });

  // ── Step 4: T6 vaga com 1 meet link → slot_2/slot_3 repetem slot_1 ───────

  describe('Step 4 — T6 slots parciais: vaga com 1 meet link (Worker 2)', () => {
    const ENDPOINT = '/api/webhooks/talentum/prescreening';

    it('drive Worker 2 até QUALIFIED: INITIATED + ANALYZED+QUALIFIED', async () => {
      const initRes = await api.post(ENDPOINT, envelope({
        subtype: 'INITIATED',
        prescreening: { id: OD_PSC.init2, name: `CASO ${OD_CASE_2} OD E2E` },
        profile: { id: 'od-prof-2', email: OD_EMAIL_2, phoneNumber: OD_PHONE_2 },
      }));
      expect(initRes.status).toBe(200);

      const qualRes = await api.post(ENDPOINT, envelope({
        subtype: 'ANALYZED',
        prescreening: { id: OD_PSC.qual2, name: `CASO ${OD_CASE_2} OD E2E` },
        profile: { id: 'od-prof-2', email: OD_EMAIL_2, phoneNumber: OD_PHONE_2 },
        response: {
          id: 'od-resp-2',
          state: [],
          score: 79,
          statusLabel: 'QUALIFIED',
        } as AnalyzedBlock,
      }));
      expect(qualRes.status).toBe(200);

      const { rows } = await pool.query(
        `SELECT application_funnel_stage FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [worker2Id, job2Id],
      );
      expect(rows[0].application_funnel_stage).toBe('QUALIFIED');

      // Dispara QualifiedInterviewHandler manualmente (Pub/Sub mockado em test)
      const { rows: evtRows } = await pool.query(
        `SELECT id FROM domain_events WHERE event = 'funnel_stage.qualified'
           AND payload @> $1::jsonb ORDER BY created_at DESC LIMIT 1`,
        [JSON.stringify({ workerId: worker2Id })],
      );
      expect(evtRows).toHaveLength(1);
      const pushBody = {
        message: {
          data: Buffer.from(JSON.stringify({ eventId: evtRows[0].id as string })).toString('base64'),
          messageId: 'test-msg-2',
          publishTime: new Date().toISOString(),
        },
        subscription: 'test-sub',
      };
      const procRes = await api.post('/api/internal/events/process', pushBody, {
        headers: { 'X-Internal-Secret': INTERNAL_SECRET },
      });
      expect(procRes.status).toBe(200);
    });

    it('messaging_outbox: slot_1 formatado + slot_2/slot_3 repetem slot_1 (nunca vazios)', async () => {
      const { rows } = await pool.query(
        `SELECT template_slug, status, attempts, variables, twilio_sid
         FROM messaging_outbox
         WHERE worker_id = $1 AND template_slug = 'qualified_worker_request'
         ORDER BY created_at DESC LIMIT 1`,
        [worker2Id],
      );

      expect(rows).toHaveLength(1);
      const outbox = rows[0] as {
        template_slug: string;
        status: string;
        attempts: number;
        variables: Record<string, string>;
        twilio_sid: string | null;
      };

      expect(outbox.template_slug).toBe('qualified_worker_request');
      expect(outbox.status).toBe('pending');
      expect(outbox.attempts).toBe(0);
      expect(outbox.twilio_sid).toBeNull();

      // slot_1: vaga tem DT_1 preenchido → formatSlotLabel(DT_1)
      expect(outbox.variables.slot_1).toBe('Lun 10/08 07:00'); // 10:00Z no fuso da vaga (AR)
      // slot_2/slot_3: meet_datetime_2/3 = NULL → repetem o último slot válido
      // (variável vazia derruba o envio na Meta: 'Content Variables invalid')
      expect(outbox.variables.slot_2).toBe('Lun 10/08 07:00');
      expect(outbox.variables.slot_3).toBe('Lun 10/08 07:00');
      expect(outbox.variables.case_number).toBe(String(OD_CASE_2));
      expect(outbox.variables.job_posting_id).toBe(job2Id);
    });
  });

  // ── Step 5: T7 slot sem link — fallback agenda o primeiro slot futuro ────

  describe('Step 5 — T7 fallback: ButtonPayload=slot_2 sem meet_link_2 agenda slot_1 (Worker 2)', () => {
    const INVITE_SID = 'SM_OD2_INVITE_FIXED';

    beforeAll(async () => {
      // Simular invite enviado e twilio_sid gravado
      await pool.query(
        `UPDATE messaging_outbox SET twilio_sid = $1, status = 'sent', attempts = 1
         WHERE worker_id = $2 AND template_slug = 'qualified_worker_request'
           AND twilio_sid IS NULL`,
        [INVITE_SID, worker2Id],
      );
      // Garantir WJA em QUALIFIED + pending
      await pool.query(
        `UPDATE worker_job_applications
         SET application_funnel_stage = 'QUALIFIED', interview_response = 'pending',
             interview_meet_link = NULL, updated_at = NOW()
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [worker2Id, job2Id],
      );
    });

    it('POST ButtonPayload=slot_2 → 200 (fallback, não crasha)', async () => {
      const res = await api.post(
        '/api/webhooks/twilio/inbound',
        new URLSearchParams({
          From: `whatsapp:${OD_PHONE_2}`,
          ButtonPayload: 'slot_2',
          OriginalRepliedMessageSid: INVITE_SID,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
      expect(res.status).toBe(200);
    });

    it('WJA CONFIRMED no slot 1 (o convite mostrou esse horário nos 3 botões)', async () => {
      const { rows } = await pool.query(
        `SELECT application_funnel_stage, interview_response, interview_meet_link
         FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [worker2Id, job2Id],
      );
      expect(rows[0].application_funnel_stage).toBe('CONFIRMED');
      expect(rows[0].interview_response).toBe('confirmed');
      expect(rows[0].interview_meet_link).toBe(OD_ML_1);
    });

    it('qualified_worker_response enfileirado para Worker 2 (fallback confirmou)', async () => {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS qtd FROM messaging_outbox
         WHERE worker_id = $1 AND template_slug = 'qualified_worker_response'`,
        [worker2Id],
      );
      expect(rows[0].qtd).toBe(1);
    });
  });

  // ── Invariante final: Worker 1 ainda tem apenas 1 T7 após Part 2 ──────────

  describe('Invariante final — Worker 1 preserva dedup entre Parts 1 e 2', () => {
    it('qualified_worker_response de Worker 1 continua com exatamente 1 row', async () => {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS qtd FROM messaging_outbox
         WHERE worker_id = $1 AND template_slug = 'qualified_worker_response'`,
        [worker1Id],
      );
      expect(rows[0].qtd).toBe(1);
    });
  });
});
