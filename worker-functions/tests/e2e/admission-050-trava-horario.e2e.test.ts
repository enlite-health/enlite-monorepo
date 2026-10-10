/**
 * spec 050 F8 (R-39): a trava de horário da admissão vale só para reunião ATIVA (`status='booked'`).
 *
 * Banco real com as migrations do HEAD (índice `uq_admission_appointments_host_slot_booked`, migration 510); Google/Twilio dublados.
 * Dados sintéticos. A1 = cancelar e reagendar (site e painel), A2 = corrida, A3 = ativa + nova, A4 = migration 2×, A5 = código × horário.
 * O cancelamento é um UPDATE de status (o efeito no Calendar não é o que se mede aqui).
 */
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { DateTime } from 'luxon';
import { FakeAdmissionCalendar } from '../../src/modules/matching/infrastructure/doubles/FakeAdmissionCalendar';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import { TactiqLinkService } from '../../src/modules/matching/application/TactiqLinkService';
import { TactiqLinkRepository } from '../../src/modules/matching/infrastructure/TactiqLinkRepository';
import { AdmissionSchedulingService, SlotTakenError } from '../../src/modules/matching/application/AdmissionSchedulingService';
import { AdmissionSchedulingController } from '../../src/modules/matching/interfaces/controllers/AdmissionSchedulingController';
import * as admissionCode from '../../src/modules/matching/domain/admissionCode';
import { interviewHostRepository } from '../../src/modules/matching/infrastructure/InterviewHostRepository';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const MIGRATION = path.join(__dirname, '../../migrations/510_admission_050_appointments_unique_booked_only.sql');
const INDEX = 'uq_admission_appointments_host_slot_booked';

const RUN = `t${Date.now().toString(36)}`;
const HOST = `host.trava.${RUN}@example.test`;
const CAL_AR = `cal-ar-${RUN}@example.test`;
const AR_ZONE = 'America/Argentina/Buenos_Aires';

describe('trava de horário só para reunião ativa (spec 050 F8, R-39)', () => {
  let admin: Pool;
  let service: AdmissionSchedulingService;
  let patientId: string;
  const envAnterior: Record<string, string | undefined> = {};
  let dayOffset = 20 + Math.floor(Math.random() * 300);

  const setEnv = (k: string, v: string): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    process.env[k] = v;
  };
  /** Dia útil futuro às 11:00 em Buenos Aires, único por chamada. */
  function nextSlot(): string {
    let d: DateTime;
    do {
      d = DateTime.now().setZone(AR_ZONE).plus({ days: ++dayOffset }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
    } while (d.weekday > 5);
    return d.toISO() as string;
  }
  const count = async (slot: string, status: string): Promise<number> =>
    Number((await admin.query(`SELECT count(*) FROM admission_appointments WHERE patient_id=$1 AND slot_start=$2 AND status=$3`, [patientId, slot, status])).rows[0].count);
  const cancelAll = async (slot: string): Promise<void> => {
    await admin.query(`UPDATE admission_appointments SET status='cancelled' WHERE patient_id=$1 AND slot_start=$2 AND status='booked'`, [patientId, slot]);
  };
  const siteBook = async (slot: string): Promise<{ status: number; body: unknown }> => {
    let status = 200;
    let body: unknown;
    const res = { status: (s: number) => ((status = s), res), json: (b: unknown) => ((body = b), res) } as never;
    await new AdmissionSchedulingController(service).book({ body: { patientId, slotStartISO: slot, country: 'AR' } } as never, res);
    return { status, body };
  };
  const panelBook = (slot: string) => service.bookForHost({ patientId, hostEmail: HOST, slotStartISO: slot, actorUid: 'staff-uid-1' });

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    setEnv('ADMISSION_HOST_ROSTER_ENABLED', 'true');
    setEnv('ADMISSION_CALENDAR_ID_AR', CAL_AR);
    await admin.query(`INSERT INTO interview_hosts (email, display_name, country, active) VALUES ($1,'Trava','AR',true)`, [HOST]);
    await admin.query(`DELETE FROM tactiq_links WHERE lower(host_email) = $1`, [HOST]);
    await admin.query(`INSERT INTO tactiq_links (host_email, firebase_uid, status) VALUES ($1,$2,'linked')`, [HOST, `tq-${HOST}`]);
    const p = await admin.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent, contact_email_encrypted)
       VALUES ($1,'Carla','Sintetico','AR',false,true,'cipher') RETURNING id`,
      [`e2e-050-trava-${RUN}`],
    );
    patientId = p.rows[0].id;
    const pool = DatabaseConnection.getInstance().getPool();
    const gate = new TactiqLinkService({ repo: new TactiqLinkRepository(pool), oauth: new FakeTactiqOAuth(), mcp: new FakeTactiqMcp(), db: pool });
    const notifier = { onBooked: async () => undefined } as never;
    const encryption = { decrypt: async () => `familia.${RUN}@example.test` } as never;
    service = new AdmissionSchedulingService(new FakeAdmissionCalendar(), notifier, encryption, 'enlite@enlite.health', interviewHostRepository, gate);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await admin.query(`DELETE FROM admission_appointments WHERE patient_id = $1`, [patientId]);
    await admin.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    await admin.query('DELETE FROM interview_hosts WHERE email = $1', [HOST]);
    await admin.query('DELETE FROM tactiq_links WHERE lower(host_email) = $1', [HOST]);
    await admin.end();
    await DatabaseConnection.getInstance().close();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('A8-1 site: cancelar e reagendar a mesma responsável no mesmo horário → 200 (controle: com a ativa em pé → 409)', async () => {
    const slot = nextSlot();
    expect((await siteBook(slot)).status).toBe(200);
    expect(await siteBook(slot)).toEqual({ status: 409, body: { success: false, error: 'SLOT_TAKEN' } }); // controle: a trava segura a ativa
    await cancelAll(slot);
    expect((await siteBook(slot)).status).toBe(200);
    expect(await count(slot, 'cancelled')).toBe(1);
    expect(await count(slot, 'booked')).toBe(1);
  });

  it('A8-1 painel: cancelar e reagendar a mesma responsável no mesmo horário → reserva criada (o controlador responde 201)', async () => {
    const slot = nextSlot();
    await panelBook(slot);
    await expect(panelBook(slot)).rejects.toBeInstanceOf(SlotTakenError); // controle
    await cancelAll(slot);
    const again = await panelBook(slot);
    expect(again.appointmentId).toBeTruthy();
    expect(await count(slot, 'booked')).toBe(1);
    expect(await count(slot, 'cancelled')).toBe(1);
  });

  it('A8-2: dois agendamentos simultâneos no mesmo horário (site e painel) → exatamente 1 booked', async () => {
    const a = nextSlot();
    const rA = await Promise.allSettled([service.book({ patientId, slotStartISO: a, country: 'AR' }), service.book({ patientId, slotStartISO: a, country: 'AR' })]);
    expect(rA.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((rA.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(SlotTakenError);
    expect(await count(a, 'booked')).toBe(1);

    const b = nextSlot();
    const rB = await Promise.allSettled([panelBook(b), panelBook(b)]);
    expect(rB.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await count(b, 'booked')).toBe(1);
  });

  it('A8-3: booked existente + novo no mesmo horário → 409; horário diferente da mesma responsável segue livre', async () => {
    const slot = nextSlot();
    await panelBook(slot);
    expect((await siteBook(slot)).status).toBe(409);
    expect((await siteBook(nextSlot())).status).toBe(200); // controle positivo: a trava não é "uma por responsável"
    expect(await count(slot, 'booked')).toBe(1);
  });

  it('A8-4: a migration 510 aplicada 2× não dá erro, vindo do índice cheio (283) e já aplicada', async () => {
    await admin.query(`DELETE FROM admission_appointments WHERE patient_id = $1`, [patientId]);
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im); // a 509 abriu transação própria e gera aviso no boot
    await admin.query(`DROP INDEX IF EXISTS ${INDEX}`);
    await admin.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_admission_appointments_host_slot ON admission_appointments (host_email, slot_start)`);
    await admin.query(sql); // 1ª: parte do estado da 283
    await admin.query(sql); // 2ª: já aplicada
    const idx = await admin.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename='admission_appointments' AND indexname LIKE 'uq_admission_appointments_host_slot%'`,
    );
    expect(idx.rows.map((r) => r.indexname)).toEqual([INDEX]);
    expect(idx.rows[0].indexdef).toMatch(/UNIQUE INDEX .*\(host_email, slot_start\) WHERE \(status = 'booked'::text\)/);
  });

  it('A8-5: colisão de CÓDIGO segue tentando outro código; colisão de HORÁRIO segue virando SlotTakenError (nomes de índice distintos)', async () => {
    const s1 = nextSlot();
    const s2 = nextSlot();
    const first = await panelBook(s1);
    const taken = (await admin.query<{ admission_code: string }>(`SELECT admission_code FROM admission_appointments WHERE id=$1`, [first.appointmentId])).rows[0].admission_code;

    // No banco: cada violação carrega o nome do SEU índice.
    const dupCode = admin.query(
      `INSERT INTO admission_appointments (patient_id, country, host_email, slot_start, slot_end, status, admission_code) VALUES ($1,'AR',$2,$3,$3,'booked',$4)`,
      [patientId, `outra.${RUN}@example.test`, s2, taken],
    );
    await expect(dupCode).rejects.toMatchObject({ code: '23505', constraint: 'uq_admission_appointments_code' });
    const dupSlot = admin.query(
      `INSERT INTO admission_appointments (patient_id, country, host_email, slot_start, slot_end, status) VALUES ($1,'AR',$2,$3,$3,'booked')`,
      [patientId, HOST, s1],
    );
    await expect(dupSlot).rejects.toMatchObject({ code: '23505', constraint: INDEX });

    // No serviço: o 1º código sorteado colide (→ novo código, reserva feita); depois um horário tomado (→ SlotTakenError).
    const gen = jest.spyOn(admissionCode, 'generateAdmissionCode').mockReturnValueOnce(taken as never);
    const ok = await panelBook(s2);
    expect(ok.admissionCode).not.toBe(taken);
    expect(gen).toHaveBeenCalledTimes(2);
    expect(await count(s2, 'booked')).toBe(1);
    await expect(panelBook(s1)).rejects.toBeInstanceOf(SlotTakenError);
  });
});
