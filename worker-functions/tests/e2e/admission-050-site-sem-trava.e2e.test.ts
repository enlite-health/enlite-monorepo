/**
 * spec 050 (D495): o SITE se comporta como na `main` — sorteia entre as responsáveis ativas do roster SEM olhar o vínculo Tactiq.
 * A trava do vínculo vale só para o PAINEL (049). Se a trava do site voltar por engano, este arquivo fica vermelho.
 *
 * Banco real, gate de PRODUÇÃO (`TactiqLinkService.statesFor` sobre `tactiq_links`), Google/Twilio dublados. Dados sintéticos.
 */
import { Pool } from 'pg';
import { DateTime } from 'luxon';
import { FakeAdmissionCalendar } from '../../src/modules/matching/infrastructure/doubles/FakeAdmissionCalendar';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import { TactiqLinkService } from '../../src/modules/matching/application/TactiqLinkService';
import { TactiqLinkRepository } from '../../src/modules/matching/infrastructure/TactiqLinkRepository';
import { AdmissionSchedulingService } from '../../src/modules/matching/application/AdmissionSchedulingService';
import { TactiqLinkRequiredError } from '../../src/modules/matching/application/ports/TactiqPorts';
import { AdmissionSchedulingController } from '../../src/modules/matching/interfaces/controllers/AdmissionSchedulingController';
import { interviewHostRepository } from '../../src/modules/matching/infrastructure/InterviewHostRepository';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = `t${Date.now().toString(36)}`;
const SEM = `sem.vinculo.${RUN}@example.test`;
const CAL_AR = `cal-ar-${RUN}@example.test`;
const AR_ZONE = 'America/Argentina/Buenos_Aires';

describe('site sem a trava do vínculo Tactiq; painel segue travado (spec 050, D495)', () => {
  let admin: Pool;
  let calendar: FakeAdmissionCalendar;
  let service: AdmissionSchedulingService;
  let patientId: string;
  const envAnterior: Record<string, string | undefined> = {};
  let dayOffset = 10 + Math.floor(Math.random() * 300);

  const setEnv = (k: string, v: string): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    process.env[k] = v;
  };
  function nextSlot(): string {
    let d = DateTime.now().setZone(AR_ZONE).plus({ days: ++dayOffset }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
    while (d.weekday > 5) d = DateTime.now().setZone(AR_ZONE).plus({ days: ++dayOffset }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
    return d.toISO() as string;
  }
  const rows = async () =>
    (await admin.query(`SELECT host_email FROM admission_appointments WHERE patient_id = $1 ORDER BY created_at`, [patientId])).rows.map((r) => r.host_email as string);

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    setEnv('ADMISSION_HOST_ROSTER_ENABLED', 'true');
    setEnv('ADMISSION_CALENDAR_ID_AR', CAL_AR);
    await admin.query(`INSERT INTO interview_hosts (email, display_name, country, active) VALUES ($1,'Sem','AR',true)`, [SEM]);
    await admin.query('DELETE FROM tactiq_links WHERE lower(host_email) = $1', [SEM]); // SEM linha em tactiq_links
    const p = await admin.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, has_consent, contact_email_encrypted)
       VALUES ($1,'Carla','Sintetico','AR',false,true,'cipher') RETURNING id`,
      [`e2e-050-sem-trava-${RUN}`],
    );
    patientId = p.rows[0].id;
    const pool = DatabaseConnection.getInstance().getPool();
    const gate = new TactiqLinkService({ repo: new TactiqLinkRepository(pool), oauth: new FakeTactiqOAuth(), mcp: new FakeTactiqMcp(), db: pool });
    calendar = new FakeAdmissionCalendar();
    const notifier = { onBooked: async () => undefined } as never;
    const encryption = { decrypt: async () => `familia.${RUN}@example.test` } as never;
    service = new AdmissionSchedulingService(calendar, notifier, encryption, 'enlite@enlite.health', interviewHostRepository, gate);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM admission_appointments WHERE patient_id = $1`, [patientId]);
    await admin.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    await admin.query('DELETE FROM interview_hosts WHERE email = $1', [SEM]);
    await admin.end();
    await DatabaseConnection.getInstance().close();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('responsável ativa SEM linha em tactiq_links: o site lista horário (200, só { slots }, sem message) e agenda', async () => {
    const json = jest.fn();
    await new AdmissionSchedulingController(service).getSlots({ query: { country: 'AR' } } as never, { status: jest.fn().mockReturnThis(), json } as never);
    const body = json.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['slots']);
    expect((body.slots as unknown[]).length).toBeGreaterThan(0);

    await service.book({ patientId, slotStartISO: nextSlot(), country: 'AR' });
    expect(await rows()).toEqual([SEM]);
    expect(calendar.created.map((c) => c.coHostEmail)).toEqual([SEM]);
  });

  it('controle: pelo PAINEL a mesma responsável sem vínculo segue recusada (TACTIQ_LINK_REQUIRED) e nada é gravado', async () => {
    const antes = (await rows()).length;
    const err = await service.bookForHost({ patientId, hostEmail: SEM, slotStartISO: nextSlot(), actorUid: 'staff-uid-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(TactiqLinkRequiredError);
    expect((err as TactiqLinkRequiredError).code).toBe('TACTIQ_LINK_REQUIRED');
    expect((await rows()).length).toBe(antes);
  });
});
