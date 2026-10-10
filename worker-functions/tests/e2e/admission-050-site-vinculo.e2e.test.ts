/**
 * spec 050 F7, A7-1 (R-23 parcial, R-26): o SITE só sorteia responsável que passa na trava do vínculo Tactiq.
 *
 * Banco real, gate de PRODUÇÃO (`TactiqLinkService.statesFor` sobre `tactiq_links`), Google/Twilio dublados. Dados sintéticos.
 *  - responsável SEM vínculo nunca é sorteada nem tem a agenda lida; COM vínculo agenda (controle positivo);
 *  - ninguém apta → lista vazia, alarme `admission.site.no_eligible_host` (contagem, sem e-mail) e a mensagem de contato
 *    na resposta HTTP; `book` não cria nada;
 *  - a trava segue o banco AO VIVO: religar o vínculo volta a agendar.
 */
import { Pool } from 'pg';
import { DateTime } from 'luxon';
import { FakeAdmissionCalendar } from '../../src/modules/matching/infrastructure/doubles/FakeAdmissionCalendar';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import { TactiqLinkService } from '../../src/modules/matching/application/TactiqLinkService';
import { TactiqLinkRepository } from '../../src/modules/matching/infrastructure/TactiqLinkRepository';
import { AdmissionSchedulingService, SlotTakenError } from '../../src/modules/matching/application/AdmissionSchedulingService';
import { AdmissionSchedulingController } from '../../src/modules/matching/interfaces/controllers/AdmissionSchedulingController';
import { NO_ELIGIBLE_HOST_EVENT, NO_ELIGIBLE_HOST_MESSAGE, noEligibleHost } from '../../src/modules/matching/application/admissionHostEligibility';
import { interviewHostRepository } from '../../src/modules/matching/infrastructure/InterviewHostRepository';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger } from '@shared/logging';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = `s${Date.now().toString(36)}`;
const SEM = `sem.vinculo.${RUN}@example.test`;
const COM = `com.vinculo.${RUN}@example.test`;
const CAL_AR = `cal-ar-${RUN}@example.test`;
const AR_ZONE = 'America/Argentina/Buenos_Aires';

describe('site só sorteia responsável com vínculo Tactiq (spec 050 F7, A7-1)', () => {
  let admin: Pool;
  let calendar: FakeAdmissionCalendar;
  let service: AdmissionSchedulingService;
  let gate: TactiqLinkService;
  let patientId: string;
  let warns: unknown[][];
  let warnSpy: jest.SpyInstance;
  const envAnterior: Record<string, string | undefined> = {};
  let dayOffset = 10 + Math.floor(Math.random() * 300);

  const setEnv = (k: string, v: string): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  /** Dia útil futuro às 11:00 em Buenos Aires — único por chamada (a trava do banco é UNIQUE(host_email, slot_start)). */
  function nextSlot(): string {
    // O deslocamento em si pula o fim de semana: dois pedidos nunca caem no mesmo dia (a trava do banco os recusaria).
    let d = DateTime.now().setZone(AR_ZONE).plus({ days: ++dayOffset }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
    while (d.weekday > 5) d = DateTime.now().setZone(AR_ZONE).plus({ days: ++dayOffset }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
    return d.toISO() as string;
  }

  const setLink = async (email: string, status: 'linked' | 'broken' | null): Promise<void> => {
    await admin.query('DELETE FROM tactiq_links WHERE lower(host_email) = $1', [email]);
    if (status) await admin.query(`INSERT INTO tactiq_links (host_email, firebase_uid, status) VALUES ($1,$2,$3)`, [email, `tq-${email}`, status]);
  };
  const rows = async () =>
    (await admin.query(`SELECT host_email FROM admission_appointments WHERE patient_id = $1 ORDER BY created_at`, [patientId])).rows.map((r) => r.host_email as string);
  const alarms = () => warns.filter((a) => (a[0] as { event?: string })?.event === NO_ELIGIBLE_HOST_EVENT);

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    setEnv('ADMISSION_HOST_ROSTER_ENABLED', 'true');
    setEnv('ADMISSION_CALENDAR_ID_AR', CAL_AR);
    await admin.query(`INSERT INTO interview_hosts (email, display_name, country, active) VALUES ($1,'Sem','AR',true), ($2,'Com','AR',true)`, [SEM, COM]);
    const p = await admin.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent, contact_email_encrypted)
       VALUES ($1,'Carla','Sintetico','AR',false,true,'cipher') RETURNING id`,
      [`e2e-050-site-${RUN}`],
    );
    patientId = p.rows[0].id;
    const pool = DatabaseConnection.getInstance().getPool();
    gate = new TactiqLinkService({ repo: new TactiqLinkRepository(pool), oauth: new FakeTactiqOAuth(), mcp: new FakeTactiqMcp(), db: pool });
    calendar = new FakeAdmissionCalendar();
    const notifier = { onBooked: async () => undefined } as never;
    const encryption = { decrypt: async () => `familia.${RUN}@example.test` } as never;
    service = new AdmissionSchedulingService(calendar, notifier, encryption, 'enlite@enlite.health', interviewHostRepository, gate);
  });

  beforeEach(() => {
    warns = [];
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(((...a: unknown[]) => { warns.push(a); }) as never);
    jest.spyOn(calendar, 'getFreeBusyByCalendar');
  });

  afterEach(() => {
    warnSpy.mockRestore();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM admission_appointments WHERE patient_id = $1`, [patientId]);
    await admin.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    await admin.query('DELETE FROM interview_hosts WHERE email = ANY($1)', [[SEM, COM]]);
    await admin.query('DELETE FROM tactiq_links WHERE lower(host_email) = ANY($1)', [[SEM, COM]]);
    await admin.end();
    await DatabaseConnection.getInstance().close();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('A7-1: com UMA responsável sem vínculo e UMA com vínculo, só a com vínculo é lida e agenda (várias vezes, sempre ela)', async () => {
    await setLink(SEM, null);
    await setLink(COM, 'linked');

    const slots = await service.getAvailableSlots('AR');
    expect(slots.length).toBeGreaterThan(0); // controle: o zero abaixo não é calendário vazio
    const asked = (calendar.getFreeBusyByCalendar as jest.Mock).mock.calls.flatMap((c) => c[0] as string[]);
    expect(asked).toEqual([COM]); // a agenda da SEM nem é lida

    for (let i = 0; i < 3; i += 1) {
      await service.book({ patientId, slotStartISO: nextSlot(), country: 'AR' });
    }
    expect(await rows()).toEqual([COM, COM, COM]);
    expect(calendar.created.map((c) => c.coHostEmail)).toEqual([COM, COM, COM]);
    expect(alarms()).toHaveLength(0);
  });

  it('A7-1: vínculo quebrado também não é apta — o mesmo estado que o painel recusa', async () => {
    await setLink(SEM, 'broken');
    await setLink(COM, null);

    expect(await service.getAvailableSlots('AR')).toEqual([]);
    await expect(service.book({ patientId, slotStartISO: nextSlot(), country: 'AR' })).rejects.toBeInstanceOf(SlotTakenError);
    expect((await rows()).length).toBe(3); // nada novo além das 3 do teste anterior
  });

  it('R-26: ninguém apta → lista vazia, 1 alarme por consulta (só contagem, sem e-mail) e a mensagem de contato na resposta HTTP', async () => {
    await setLink(SEM, null);
    await setLink(COM, null);

    const before = (await rows()).length;
    const json = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json } as never;
    await new AdmissionSchedulingController(service, (c) => noEligibleHost(interviewHostRepository, gate, c)).getSlots({ query: { country: 'AR' } } as never, res);

    expect(json).toHaveBeenCalledWith({ slots: [], message: NO_ELIGIBLE_HOST_MESSAGE });
    expect(alarms()).toHaveLength(1);
    expect(alarms()[0][0]).toEqual({ event: NO_ELIGIBLE_HOST_EVENT, country: 'AR', rosterSize: 2 });
    expect(JSON.stringify(warns)).not.toContain('@example.test');

    await expect(service.book({ patientId, slotStartISO: nextSlot(), country: 'AR' })).rejects.toBeInstanceOf(SlotTakenError);
    expect((await rows()).length).toBe(before);
    expect(calendar.created.length).toBe(3);
  });

  it('a trava segue o banco AO VIVO: religar o vínculo volta a oferecer horários e a agendar (controle positivo)', async () => {
    await setLink(SEM, 'linked');
    const json = jest.fn();
    await new AdmissionSchedulingController(service, (c) => noEligibleHost(interviewHostRepository, gate, c)).getSlots({ query: { country: 'AR' } } as never, { status: jest.fn().mockReturnThis(), json } as never);
    const body = json.mock.calls[0][0] as { slots: unknown[]; message?: string };
    expect(body.slots.length).toBeGreaterThan(0);
    expect(body.message).toBeUndefined();

    await service.book({ patientId, slotStartISO: nextSlot(), country: 'AR' });
    expect((await rows()).pop()).toBe(SEM);
  });
});
