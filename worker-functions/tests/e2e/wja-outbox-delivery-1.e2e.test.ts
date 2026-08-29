/**
 * wja-outbox-delivery-1.e2e.test.ts  (Fase C do gate de regressão WJA — Part 1 de 2)
 *
 * Valida o payload completo gravado em messaging_outbox:
 *   T6 — qualified_worker_request: slot_1/slot_2/slot_3 via formatSlotOption (UTC)
 *   T7 — qualified_worker_response: date/time via formatDateUTC/formatTimeUTC (UTC)
 *   Dedup T7: window 5min impede duplicatas.
 *
 * Part 2 (wja-outbox-delivery-2.e2e.test.ts): T6 com slots parciais + T7 invalid slot.
 *
 * Ambiente: USE_MOCK_AUTH=true, USE_MOCK_GOOGLE_CALENDAR=true, sem Firebase.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { envelope } from '../fixtures/talentumPayload';
import type { AnalyzedBlock } from './wja-full-flow-types';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';

// ── Constantes exportadas para Part 2 ────────────────────────────────────────

export const OD_CASE_1 = 99960;
export const OD_CASE_2 = 99961;

export const OD_PHONE_1 = '+5491199960001';
export const OD_PHONE_2 = '+5491199960002';
export const OD_EMAIL_1 = 'wja-outbox-1@e2e.local';
export const OD_EMAIL_2 = 'wja-outbox-2@e2e.local';

/** Datetimes UTC → formatSlotOption usa getUTC*; dias calculados com node */
export const OD_DT_1 = '2099-08-10T10:00:00Z'; // Lun 10/08 07:00 em Buenos Aires (UTC-3)
export const OD_DT_2 = '2099-08-10T14:00:00Z'; // Lun 10/08 11:00 AR
export const OD_DT_3 = '2099-08-11T09:30:00Z'; // Mar 11/08 06:30 AR

export const OD_ML_1 = 'https://meet.google.com/outbox-e2e-slot1';
export const OD_ML_2 = 'https://meet.google.com/outbox-e2e-slot2';
export const OD_ML_3 = 'https://meet.google.com/outbox-e2e-slot3';

export const OD_PSC = {
  init1: 'od-psc-init-1',
  inp1:  'od-psc-inp-1',
  comp1: 'od-psc-comp-1',
  qual1: 'od-psc-qual-1',
  init2: 'od-psc-init-2',
  qual2: 'od-psc-qual-2',
};

const STATE_FILE = path.join(__dirname, '.wja-outbox-delivery-state.json');

interface OdState {
  worker1Id: string;
  worker2Id: string;
  job1Id: string;
  job2Id: string;
}

function saveState(s: OdState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s), 'utf-8');
}

// ── Suite Part 1 ──────────────────────────────────────────────────────────────

describe('WJA Outbox Delivery Part 1 — T6 + T7 + Dedup @integration', () => {
  const api = createApiClient();
  let pool: Pool;

  let worker1Id: string;
  let job1Id: string;

  // ── beforeAll: seed workers + vagas + templates ───────────────────────────

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });

    // Limpar resíduos de runs anteriores
    await pool.query(
      `DELETE FROM job_postings WHERE case_number = ANY($1::int[])`,
      [[OD_CASE_1, OD_CASE_2]],
    );
    await pool.query(
      `DELETE FROM workers WHERE email = ANY($1::text[])`,
      [[OD_EMAIL_1, OD_EMAIL_2]],
    );
    await pool.query(
      `DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id = ANY($1::text[])`,
      [Object.values(OD_PSC)],
    );

    // Worker 1 — receberá T6 com 3 slots + T7
    const w1 = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, phone, status, country)
       VALUES ('od-uid-1', $1, $2, 'REGISTERED', 'AR') RETURNING id`,
      [OD_EMAIL_1, OD_PHONE_1],
    );
    worker1Id = w1.rows[0].id;

    // Worker 2 — seed apenas; lógica de T6 parcial fica em Part 2
    const w2 = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, phone, status, country)
       VALUES ('od-uid-2', $1, $2, 'REGISTERED', 'AR') RETURNING id`,
      [OD_EMAIL_2, OD_PHONE_2],
    );
    const worker2Id = w2.rows[0].id;

    // Vaga 1 — 3 meet links/datetimes
    const j1 = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (
         case_number, title, status,
         meet_link_1, meet_datetime_1,
         meet_link_2, meet_datetime_2,
         meet_link_3, meet_datetime_3
       ) VALUES ($1, $2, 'SEARCHING', $3, $4, $5, $6, $7, $8) RETURNING id`,
      [OD_CASE_1, `CASO ${OD_CASE_1} OD E2E`, OD_ML_1, OD_DT_1, OD_ML_2, OD_DT_2, OD_ML_3, OD_DT_3],
    );
    job1Id = j1.rows[0].id;

    // Vaga 2 — apenas meet_link_1 (2 e 3 NULL) — usada em Part 2
    const j2 = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (case_number, title, status, meet_link_1, meet_datetime_1)
       VALUES ($1, $2, 'SEARCHING', $3, $4) RETURNING id`,
      [OD_CASE_2, `CASO ${OD_CASE_2} OD E2E`, OD_ML_1, OD_DT_1],
    );
    const job2Id = j2.rows[0].id;

    // Persistir IDs para Part 2
    saveState({ worker1Id, worker2Id, job1Id, job2Id });

    // Templates — ON CONFLICT DO NOTHING para não colidir com outros suites
    await pool.query(`
      INSERT INTO message_templates (slug, name, body, is_active, created_at, updated_at) VALUES
        ('qualified_worker_request',     'Convite Entrevista',    '{{slot_1}}{{slot_2}}{{slot_3}}', true, NOW(), NOW()),
        ('qualified_worker',             'Convite (legacy)',       '{{slot_1}}{{slot_2}}{{slot_3}}', true, NOW(), NOW()),
        ('qualified_worker_response',    'Confirmação Entrevista', '{{date}}{{time}}',              true, NOW(), NOW()),
        ('qualified_reminder_confirm',   'Confirmação 24h',        '¿Confirma?',                    true, NOW(), NOW()),
        ('qualified_reminder_reschedule','Reagendar',              '¿Te gustaría reagendar?',       true, NOW(), NOW()),
        ('qualified_reminder_reason',    'Motivo rechazo',         '¿Por qué no podés?',            true, NOW(), NOW()),
        ('qualified_declined_admin',     'Declinó (legacy)',       'Declinó.',                      true, NOW(), NOW()),
        ('qualified_declined_thanks',    'Declinó',                '{{worker_id}} declinó.',         true, NOW(), NOW())
      ON CONFLICT (slug) DO NOTHING
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  // ── Step 1: T6 payload completo com 3 slots formatados ───────────────────

  describe('Step 1 — T6: 3 slots formatados via formatSlotOption (UTC)', () => {
    const ENDPOINT = '/api/webhooks/talentum/prescreening';

    it('drive INITIATED + IN_PROGRESS + COMPLETED via Talentum', async () => {
      for (const [subtype, id] of [
        ['INITIATED',   OD_PSC.init1] as const,
        ['IN_PROGRESS', OD_PSC.inp1]  as const,
        ['COMPLETED',   OD_PSC.comp1] as const,
      ]) {
        const res = await api.post(ENDPOINT, envelope({
          subtype,
          prescreening: { id, name: `CASO ${OD_CASE_1} OD E2E` },
          profile: { id: 'od-prof-1', email: OD_EMAIL_1, phoneNumber: OD_PHONE_1 },
        }));
        expect(res.status).toBe(200);
      }

      const { rows } = await pool.query(
        `SELECT application_funnel_stage FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [worker1Id, job1Id],
      );
      expect(rows[0].application_funnel_stage).toBe('COMPLETED');
    });

    it('webhook ANALYZED+QUALIFIED → stage=QUALIFIED + dispara QualifiedInterviewHandler', async () => {
      const res = await api.post(ENDPOINT, envelope({
        subtype: 'ANALYZED',
        prescreening: { id: OD_PSC.qual1, name: `CASO ${OD_CASE_1} OD E2E` },
        profile: { id: 'od-prof-1', email: OD_EMAIL_1, phoneNumber: OD_PHONE_1 },
        response: {
          id: 'od-resp-1',
          state: [],
          score: 88,
          statusLabel: 'QUALIFIED',
        } as AnalyzedBlock,
      }));
      expect(res.status).toBe(200);

      const { rows } = await pool.query(
        `SELECT application_funnel_stage FROM worker_job_applications
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [worker1Id, job1Id],
      );
      expect(rows[0].application_funnel_stage).toBe('QUALIFIED');

      // Em prod o handler é disparado via Pub/Sub push. Em test, Pub/Sub é mock — então
      // invocamos manualmente o endpoint interno que processa o domain_event mais recente.
      const { rows: evtRows } = await pool.query(
        `SELECT id FROM domain_events WHERE event = 'funnel_stage.qualified'
           AND payload @> $1::jsonb ORDER BY created_at DESC LIMIT 1`,
        [JSON.stringify({ workerId: worker1Id })],
      );
      expect(evtRows).toHaveLength(1);
      const eventId = evtRows[0].id as string;

      const pushBody = {
        message: {
          data: Buffer.from(JSON.stringify({ eventId })).toString('base64'),
          messageId: 'test-msg-1',
          publishTime: new Date().toISOString(),
        },
        subscription: 'test-sub',
      };
      const procRes = await api.post('/api/internal/events/process', pushBody, {
        headers: { 'X-Internal-Secret': INTERNAL_SECRET },
      });
      expect(procRes.status).toBe(200);
    });

    it('messaging_outbox: shape exato com slot_1/slot_2/slot_3 + case_number + job_posting_id', async () => {
      const { rows } = await pool.query(
        `SELECT template_slug, status, attempts, variables, twilio_sid
         FROM messaging_outbox
         WHERE worker_id = $1 AND template_slug = 'qualified_worker_request'
         ORDER BY created_at DESC LIMIT 1`,
        [worker1Id],
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

      // 2099-08-10 = segunda-feira → Lun; 2099-08-11 = terça → Mar. Rótulo no FUSO DA VAGA
      // (America/Argentina/Buenos_Aires, UTC-3 — mig 291/D211.4): 10:00Z = 07:00 AR.
      expect(outbox.variables).toEqual({
        slot_1: 'Lun 10/08 07:00',
        slot_2: 'Lun 10/08 11:00',
        slot_3: 'Mar 11/08 06:30',
        case_number: String(OD_CASE_1),
        job_posting_id: job1Id,
      });
    });
  });

  // ── Step 2: T7 payload date/time ─────────────────────────────────────────

  describe('Step 2 — T7: payload date/time após slot click', () => {
    const INVITE_SID = 'SM_OD1_INVITE_FIXED';

    beforeAll(async () => {
      // Simular que outbox processor enviou a invite e gravou o twilio_sid
      await pool.query(
        `UPDATE messaging_outbox SET twilio_sid = $1, status = 'sent', attempts = 1
         WHERE worker_id = $2 AND template_slug = 'qualified_worker_request'
           AND twilio_sid IS NULL`,
        [INVITE_SID, worker1Id],
      );
      // Garantir WJA QUALIFIED + pending para o bookSlot funcionar
      await pool.query(
        `UPDATE worker_job_applications
         SET application_funnel_stage = 'QUALIFIED', interview_response = 'pending',
             interview_meet_link = NULL, updated_at = NOW()
         WHERE worker_id = $1 AND job_posting_id = $2`,
        [worker1Id, job1Id],
      );
    });

    it('POST ButtonPayload=slot_1 → 200', async () => {
      const res = await api.post(
        '/api/webhooks/twilio/inbound',
        new URLSearchParams({
          From: `whatsapp:${OD_PHONE_1}`,
          ButtonPayload: 'slot_1',
          OriginalRepliedMessageSid: INVITE_SID,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
      expect(res.status).toBe(200);
    });

    it('qualified_worker_response: date=10/08 + time=07:00 (fuso da vaga) + job_posting_id', async () => {
      const { rows } = await pool.query(
        `SELECT template_slug, status, attempts, variables
         FROM messaging_outbox
         WHERE worker_id = $1 AND template_slug = 'qualified_worker_response'
         ORDER BY created_at DESC LIMIT 1`,
        [worker1Id],
      );

      expect(rows).toHaveLength(1);
      const outbox = rows[0] as {
        template_slug: string;
        status: string;
        attempts: number;
        variables: Record<string, string>;
      };

      expect(outbox.template_slug).toBe('qualified_worker_response');
      expect(outbox.status).toBe('pending');
      expect(outbox.variables).toEqual({
        date: '10/08',
        time: '07:00', // 10:00Z no fuso da vaga (AR, UTC-3) — mig 291/D211.4
        job_posting_id: job1Id,
      });
    });
  });

  // ── Step 3: T7 dedup — 2º clique NÃO duplica ─────────────────────────────

  describe('Step 3 — T7 dedup: 2º clique no mesmo slot NÃO duplica (window 5min)', () => {
    it('2º POST com mesmo SID + ButtonPayload=slot_1 retorna 200', async () => {
      const res = await api.post(
        '/api/webhooks/twilio/inbound',
        new URLSearchParams({
          From: `whatsapp:${OD_PHONE_1}`,
          ButtonPayload: 'slot_1',
          OriginalRepliedMessageSid: 'SM_OD1_INVITE_FIXED',
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
      expect(res.status).toBe(200);
    });

    it('continua existindo exatamente 1 row de qualified_worker_response (NOT EXISTS dedup)', async () => {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS qtd FROM messaging_outbox
         WHERE worker_id = $1 AND template_slug = 'qualified_worker_response'`,
        [worker1Id],
      );
      expect(rows[0].qtd).toBe(1);
    });
  });
});
