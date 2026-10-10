/**
 * spec 050 F9 (R-34, R-35): falha do Google na criação do evento não deixa reserva órfã.
 *
 * Banco real com as migrations do HEAD (511 amplia a CHECK de status); Google dublado (nunca o Calendar real); dados sintéticos.
 * A9-1 falha 1× → agenda com 1 evento · A9-2 falha 3× → 0 `booked`, horário reaproveitável, mensagem certa no painel e no site ·
 * A9-3 site com 2 responsáveis, a 1ª sempre falhando → agenda com a 2ª · A9-4 link vazio → 0 mensagens, 0 `booked` · A9-5 controle.
 */
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { DateTime } from 'luxon';
import { FakeAdmissionCalendar } from '../../src/modules/matching/infrastructure/doubles/FakeAdmissionCalendar';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import type { CreateEventParams } from '../../src/modules/matching/infrastructure/AdmissionCalendarService';
import { TactiqLinkService } from '../../src/modules/matching/application/TactiqLinkService';
import { TactiqLinkRepository } from '../../src/modules/matching/infrastructure/TactiqLinkRepository';
import { AdmissionSchedulingService } from '../../src/modules/matching/application/AdmissionSchedulingService';
import {
  CalendarCreateFailedError,
  releaseReservationWithoutEvent,
} from '../../src/modules/matching/application/admissionCalendarCreate';
import { AdmissionSchedulingController } from '../../src/modules/matching/interfaces/controllers/AdmissionSchedulingController';
import { AdmissionPanelController } from '../../src/modules/matching/interfaces/controllers/AdmissionPanelController';
import { AdmissionPanelService } from '../../src/modules/matching/application/AdmissionPanelService';
import { GetPatientFunnelUseCase } from '../../src/modules/case/application/GetPatientFunnelUseCase';
import { interviewHostRepository } from '../../src/modules/matching/infrastructure/InterviewHostRepository';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const MIGRATION = path.join(__dirname, '../../migrations/511_admission_050_appointments_status_calendar_failed.sql');
const MEET = 'https://meet.google.com/abc-defg-hij';

const RUN = `t${Date.now().toString(36)}`;
const HOST_A = `a.host.falha.${RUN}@example.test`; // 1ª no ranking (menos carga empata → e-mail asc)
const HOST_B = `b.host.falha.${RUN}@example.test`;
const CAL_AR = `cal-ar-${RUN}@example.test`;
const AR_ZONE = 'America/Argentina/Buenos_Aires';

/** Google dublado com defeitos programáveis. O `ids` guarda os eventos por id fixo: repetir o id NÃO duplica (modelo do Google). */
class FlakyCalendar extends FakeAdmissionCalendar {
  failures = 0; // próximas N criações lançam
  loseResponse = false; // cria o evento e perde a resposta (lança depois de criar)
  emptyLink = 0; // próximas N criações devolvem link vazio
  failForHost: string | null = null; // sempre falha quando o coHost é este
  calls: CreateEventParams[] = [];
  events = new Map<string, string>();

  async createEventWithMeet(p: CreateEventParams): Promise<{ eventId: string; meetLink: string }> {
    this.calls.push(p);
    if (this.failForHost && p.coHostEmail === this.failForHost) throw new Error('google fora');
    if (this.failures > 0) {
      this.failures -= 1;
      if (this.loseResponse && p.eventId) this.events.set(p.eventId, MEET);
      throw new Error('google fora');
    }
    if (this.emptyLink > 0) {
      this.emptyLink -= 1;
      return { eventId: p.eventId ?? 'sem-id', meetLink: '' };
    }
    if (p.eventId) this.events.set(p.eventId, MEET);
    return { eventId: p.eventId ?? 'sem-id', meetLink: MEET };
  }
}

describe('falha do Google na criação não deixa reserva órfã (spec 050 F9, R-34/R-35)', () => {
  let admin: Pool;
  let cal: FlakyCalendar;
  let service: AdmissionSchedulingService;
  let onBooked: jest.Mock;
  let patientId: string;
  const envAnterior: Record<string, string | undefined> = {};
  let dayOffset = 20 + Math.floor(Math.random() * 300);

  const setEnv = (k: string, v: string): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    process.env[k] = v;
  };
  function nextSlot(): string {
    let d: DateTime;
    do {
      d = DateTime.now().setZone(AR_ZONE).plus({ days: ++dayOffset }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
    } while (d.weekday > 5);
    return d.toISO() as string;
  }
  const count = async (slot: string, status: string): Promise<number> =>
    Number((await admin.query(`SELECT count(*) FROM admission_appointments WHERE patient_id=$1 AND slot_start=$2 AND status=$3`, [patientId, slot, status])).rows[0].count);
  const trail = async (slot: string): Promise<number> =>
    Number((await admin.query(
      `SELECT count(*) FROM admission_events e JOIN admission_appointments a ON a.id = e.appointment_id
        WHERE a.patient_id=$1 AND a.slot_start=$2 AND e.kind='calendar_create_failed'`, [patientId, slot])).rows[0].count);
  const fake = () => {
    let status = 200;
    let body: any;
    const res = { status: (s: number) => ((status = s), res), json: (b: unknown) => ((body = b), res) } as never;
    return { res, out: () => ({ status, body }) };
  };
  const siteBook = async (slot: string): Promise<{ status: number; body: unknown }> => {
    const r = fake();
    await new AdmissionSchedulingController(service).book({ body: { patientId, slotStartISO: slot, country: 'AR' } } as never, r.res);
    return r.out();
  };
  const panelBookHttp = async (slot: string, host = HOST_A): Promise<{ status: number; body: any }> => {
    const r = fake();
    await new AdmissionPanelController(service, {} as never).book(
      { params: { id: patientId }, body: { hostEmail: host, slotStartISO: slot }, authContext: { principal: { id: 'staff-uid-1' } } } as never,
      r.res,
    );
    return r.out();
  };
  const panelBook = (slot: string, host = HOST_A) => service.bookForHost({ patientId, hostEmail: host, slotStartISO: slot, actorUid: 'staff-uid-1' });

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    setEnv('ADMISSION_HOST_ROSTER_ENABLED', 'true');
    setEnv('ADMISSION_CALENDAR_ID_AR', CAL_AR);
    for (const email of [HOST_A, HOST_B]) {
      await admin.query(`INSERT INTO interview_hosts (email, display_name, country, active) VALUES ($1,'Falha','AR',true)`, [email]);
      await admin.query(`DELETE FROM tactiq_links WHERE lower(host_email) = $1`, [email]);
      await admin.query(`INSERT INTO tactiq_links (host_email, firebase_uid, status) VALUES ($1,$2,'linked')`, [email, `tq-${email}`]);
    }
    const p = await admin.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent, contact_email_encrypted)
       VALUES ($1,'Carla','Sintetico','AR',false,true,'cipher') RETURNING id`,
      [`e2e-050-f9-${RUN}`],
    );
    patientId = p.rows[0].id;
    const pool = DatabaseConnection.getInstance().getPool();
    const gate = new TactiqLinkService({ repo: new TactiqLinkRepository(pool), oauth: new FakeTactiqOAuth(), mcp: new FakeTactiqMcp(), db: pool });
    const encryption = { decrypt: async () => `familia.${RUN}@example.test` } as never;
    cal = new FlakyCalendar();
    onBooked = jest.fn(async () => undefined);
    service = new AdmissionSchedulingService(cal, { onBooked } as never, encryption, 'enlite@enlite.health', interviewHostRepository, gate);
  });

  beforeEach(() => {
    cal.failures = 0;
    cal.loseResponse = false;
    cal.emptyLink = 0;
    cal.failForHost = null;
    cal.calls = [];
    cal.events.clear();
    cal.deleted.length = 0;
    onBooked.mockClear();
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM admission_appointments WHERE patient_id = $1`, [patientId]);
    await admin.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    for (const email of [HOST_A, HOST_B]) {
      await admin.query('DELETE FROM interview_hosts WHERE email = $1', [email]);
      await admin.query('DELETE FROM tactiq_links WHERE lower(host_email) = $1', [email]);
    }
    await admin.end();
    await DatabaseConnection.getInstance().close();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('A9-5 controle: sem falha → 1 booked com evento e link, 1 aviso, 1 só chamada ao Google', async () => {
    const slot = nextSlot();
    const out = await panelBook(slot);
    expect(out.meetLink).toBe(MEET);
    expect(await count(slot, 'booked')).toBe(1);
    const row = (await admin.query(`SELECT calendar_event_id, meet_link FROM admission_appointments WHERE id=$1`, [out.appointmentId])).rows[0];
    expect(row).toEqual({ calendar_event_id: expect.stringMatching(/^[0-9a-v]{5,}$/), meet_link: MEET });
    expect(cal.calls).toHaveLength(1);
    expect(onBooked).toHaveBeenCalledTimes(1);
    expect(await trail(slot)).toBe(0);
  });

  it('A9-1: o Google falha 1× → agenda, com 1 evento só (mesmo id na nova tentativa, mesmo com a resposta perdida)', async () => {
    const slot = nextSlot();
    cal.failures = 1;
    cal.loseResponse = true; // pior caso: o evento FOI criado e a resposta se perdeu
    const out = await panelBook(slot);
    expect(out.meetLink).toBe(MEET);
    expect(cal.calls).toHaveLength(2);
    expect(cal.calls[1].eventId).toBe(cal.calls[0].eventId);
    expect(cal.events.size).toBe(1);
    expect(await count(slot, 'booked')).toBe(1);
    expect(onBooked).toHaveBeenCalledTimes(1);
    expect(await trail(slot)).toBe(0);
  });

  it('A9-2 painel: o Google falha 3× → 0 booked, 1 calendar_failed, trilha, 0 avisos, 502 com a mensagem certa; o horário é reaproveitável', async () => {
    const slot = nextSlot();
    cal.failures = 3;
    const http = await panelBookHttp(slot);
    expect(http.status).toBe(502);
    expect(http.body).toMatchObject({
      success: false,
      code: 'CALENDAR_CREATE_FAILED',
      error: 'No pudimos crear la reunión en Google. No se agendó nada. Probá de nuevo.',
    });
    expect(cal.calls).toHaveLength(3);
    expect(await count(slot, 'booked')).toBe(0);
    expect(await count(slot, 'calendar_failed')).toBe(1);
    expect(await trail(slot)).toBe(1);
    expect(onBooked).not.toHaveBeenCalled();
    // horário reaproveitável (o índice parcial da F8 não segura a linha calendar_failed)
    const again = await panelBook(slot);
    expect(again.meetLink).toBe(MEET);
    expect(await count(slot, 'booked')).toBe(1);
    expect(await count(slot, 'calendar_failed')).toBe(1);
  });

  it('A9-2 site: o Google falha sempre (1 responsável apta) → 409 SLOT_TAKEN ("elegí otro horario"), 0 booked', async () => {
    await admin.query(`UPDATE interview_hosts SET active=false WHERE email=$1`, [HOST_B]);
    try {
      const slot = nextSlot();
      cal.failForHost = HOST_A;
      expect(await siteBook(slot)).toEqual({ status: 409, body: { success: false, error: 'SLOT_TAKEN' } });
      expect(await count(slot, 'booked')).toBe(0);
      expect(await count(slot, 'calendar_failed')).toBe(1);
      expect(onBooked).not.toHaveBeenCalled();
    } finally {
      await admin.query(`UPDATE interview_hosts SET active=true WHERE email=$1`, [HOST_B]);
    }
  });

  it('A9-3: site com 2 responsáveis, a 1ª sempre falhando → agenda com a 2ª (a 1ª foi tentada 3×)', async () => {
    const slot = nextSlot();
    cal.failForHost = HOST_A;
    const out = await siteBook(slot);
    expect(out.status).toBe(200);
    expect(cal.calls.filter((c) => c.coHostEmail === HOST_A)).toHaveLength(3); // controle: ela FOI tentada
    expect(cal.calls.filter((c) => c.coHostEmail === HOST_B)).toHaveLength(1);
    const rows = (await admin.query(`SELECT host_email, status FROM admission_appointments WHERE patient_id=$1 AND slot_start=$2 ORDER BY host_email`, [patientId, slot])).rows;
    expect(rows).toEqual([{ host_email: HOST_A, status: 'calendar_failed' }, { host_email: HOST_B, status: 'booked' }]);
    expect(onBooked).toHaveBeenCalledTimes(1);
  });

  it('A9-4: link do Meet vazio sempre → 0 avisos, 0 booked, eventos apagados (um id novo por tentativa)', async () => {
    const slot = nextSlot();
    cal.emptyLink = 99;
    await expect(panelBook(slot)).rejects.toBeInstanceOf(CalendarCreateFailedError);
    expect(onBooked).not.toHaveBeenCalled();
    expect(await count(slot, 'booked')).toBe(0);
    expect(await count(slot, 'calendar_failed')).toBe(1);
    expect(cal.deleted).toHaveLength(3);
    expect(new Set(cal.deleted.map((d) => d.eventId)).size).toBe(3);
  });

  it('A9-4 (controle): link vazio só na 1ª tentativa → agenda na 2ª com id novo, 1 aviso, 1 evento apagado', async () => {
    const slot = nextSlot();
    cal.emptyLink = 1;
    const out = await panelBook(slot);
    expect(out.meetLink).toBe(MEET);
    expect(cal.deleted).toHaveLength(1);
    expect(cal.calls[1].eventId).not.toBe(cal.calls[0].eventId);
    expect(onBooked).toHaveBeenCalledTimes(1);
    expect(await count(slot, 'booked')).toBe(1);
  });

  it('compensação (a F10 chama de um job): `booked` sem evento é liberada; com evento não é tocada (controle)', async () => {
    const slotOrphan = nextSlot();
    const slotLive = nextSlot();
    const orphan = (await admin.query(
      `INSERT INTO admission_appointments (patient_id, country, host_email, slot_start, slot_end, status) VALUES ($1,'AR',$2,$3,$3,'booked') RETURNING id`,
      [patientId, HOST_A, slotOrphan])).rows[0].id;
    const live = (await admin.query(
      `INSERT INTO admission_appointments (patient_id, country, host_email, slot_start, slot_end, status, calendar_event_id, meet_link) VALUES ($1,'AR',$2,$3,$3,'booked','evt-vivo',$4) RETURNING id`,
      [patientId, HOST_A, slotLive, MEET])).rows[0].id;
    expect(await releaseReservationWithoutEvent(live, 'sem_evento')).toBe(false);
    expect(await count(slotLive, 'booked')).toBe(1);
    expect(await releaseReservationWithoutEvent(orphan, 'sem_evento')).toBe(true);
    expect(await count(slotOrphan, 'booked')).toBe(0);
    expect(await count(slotOrphan, 'calendar_failed')).toBe(1);
    expect(await trail(slotOrphan)).toBe(1);
    expect(await releaseReservationWithoutEvent(orphan, 'sem_evento')).toBe(false); // 2ª vez: nada a compensar, sem 2ª trilha
    expect(await trail(slotOrphan)).toBe(1);
  });

  it('leitores do status novo: a aba do painel não lista calendar_failed (controle: lista a booked) e o funil não conta como agendada', async () => {
    const solo = (await admin.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent) VALUES ($1,'Dora','Sintetico','AR',false,true) RETURNING id`,
      [`e2e-050-f9-leitor-${RUN}`])).rows[0].id;
    try {
      const slot = nextSlot();
      await admin.query(`INSERT INTO admission_appointments (patient_id, country, host_email, slot_start, slot_end, status) VALUES ($1,'AR',$2,$3,$3,'calendar_failed')`, [solo, HOST_A, slot]);
      const panel = new AdmissionPanelService({ db: admin } as never);
      const funnel = () =>
        new GetPatientFunnelUseCase(admin).execute({ from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 3600_000), countries: ['AR'] } as never);
      const base = (await funnel()).agendadas;
      expect(await panel.list(solo)).toHaveLength(0);
      await admin.query(`INSERT INTO admission_appointments (patient_id, country, host_email, slot_start, slot_end, status) VALUES ($1,'AR',$2,$3,$3,'booked')`, [solo, HOST_B, nextSlot()]);
      expect((await panel.list(solo)).map((a) => a.status)).toEqual(['booked']); // controle: a ativa aparece
      expect((await funnel()).agendadas).toBe(base + 1); // só a `booked` conta; a calendar_failed do mesmo paciente não somou
    } finally {
      await admin.query(`DELETE FROM admission_appointments WHERE patient_id = $1`, [solo]);
      await admin.query(`DELETE FROM patients WHERE id = $1`, [solo]);
    }
  });

  it('migration 511: aplicada 2× sem erro, sem BEGIN/COMMIT próprio; a CHECK aceita calendar_failed e recusa valor desconhecido', async () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
    await admin.query(sql);
    await admin.query(sql);
    const def = (await admin.query<{ d: string }>(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='admission_appointments_status_check'`)).rows[0].d;
    expect(def).toContain('calendar_failed');
    for (const status of ['booked', 'cancelled', 'completed', 'no_show', 'calendar_failed']) expect(def).toContain(status);
    const bad = admin.query(`INSERT INTO admission_appointments (patient_id, country, host_email, slot_start, slot_end, status) VALUES ($1,'AR','x@example.test',now(),now(),'inventado')`, [patientId]);
    await expect(bad).rejects.toMatchObject({ code: '23514' });
  });
});
