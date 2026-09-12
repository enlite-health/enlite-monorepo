/**
 * admission-scheduling-roster.e2e.test.ts
 *
 * Contra Postgres e API REAIS. O que só o banco de verdade prova:
 *
 *   · a migration 283 devolveu a trava para `UNIQUE(host_email, slot_start)`,
 *     e ela é o que impede a MESMA atendente receber dois compromissos no
 *     mesmo horário sem impedir DUAS atendentes de atenderem o mesmo horário —
 *     era exatamente isso que a trava por país (256) proibia;
 *   · duas reservas simultâneas se comportam sob a trava, não em teoria;
 *   · o endpoint público não devolve nada sobre quem atende (CM6 do veredito
 *     do `lex`).
 *
 * A agenda do Google é a única coisa dublada — o teste não pode nem deve criar
 * evento real. Tudo o mais (trava, transação, resposta HTTP) é o de produção.
 */

import axios from 'axios';
import { Pool } from 'pg';
import { DateTime } from 'luxon';
import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';
import { AdmissionSchedulingService, SlotTakenError } from '../../src/modules/matching/application/AdmissionSchedulingService';
import type {
  AdmissionCalendarService,
  BusyInterval,
  CalendarBusyResult,
} from '../../src/modules/matching/infrastructure/AdmissionCalendarService';
import type { AdmissionNotifier } from '../../src/modules/matching/application/AdmissionNotifier';
import type { KMSEncryptionService } from '../../src/shared/security/KMSEncryptionService';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const API_URL = process.env.API_URL || 'http://localhost:8080';

const AR_ZONE = 'America/Argentina/Buenos_Aires';
const CAL_AR = 'admission-e2e-ar@group.calendar.google.com';
const TEAM_AR = 'Equipo de Admisión EnLite';
const ANA = 'ana.e2e@admissionroster.test';
const MARI = 'mari.e2e@admissionroster.test';

let pool: Pool;
let patientId: string;

/**
 * "Agora" para os testes de reserva: uma segunda-feira futura às 06:00 AR.
 * Fixo em relação ao slot, nunca em relação ao relógio da máquina.
 */
const NOW = DateTime.now().setZone(AR_ZONE).plus({ weeks: 2 }).startOf('week').set({ hour: 6 }).toJSDate();
const SLOT_START = DateTime.fromJSDate(NOW, { zone: AR_ZONE }).set({ hour: 14 });

interface StubOptions {
  /** Ocupação por e-mail; ausente = totalmente livre. */
  busyByHost?: Record<string, BusyInterval[]>;
  createdEvents?: string[];
  /** E-mail convidado em cada evento criado (undefined = sem convidado). */
  invitedEmails?: (string | undefined)[];
}

/** Agenda dublada: nunca sai da máquina, nunca cria evento de verdade. */
function stubCalendar(opts: StubOptions = {}): AdmissionCalendarService {
  return {
    // Sem isto o serviço caía no `catch` do fuso e o e2e nunca exercitava o
    // caminho real — achado do gate de revisão.
    getCalendarTimezone: async () => AR_ZONE,
    getBusyIntervals: async () => [],
    getFreeBusyByCalendar: async (ids: string[]): Promise<CalendarBusyResult[]> =>
      ids.map((calendarId) => ({ calendarId, busy: opts.busyByHost?.[calendarId] ?? [] })),
    createEventWithMeet: async ({ coHostEmail, patientEmail }: { coHostEmail?: string; patientEmail?: string }) => {
      opts.createdEvents?.push(coHostEmail ?? '(sem atendente)');
      opts.invitedEmails?.push(patientEmail);
      return { eventId: `evt-${opts.createdEvents?.length ?? 0}`, meetLink: 'https://meet.google.com/e2e-test' };
    },
    deleteEvent: async () => undefined,
  } as unknown as AdmissionCalendarService;
}

function makeService(calendar: AdmissionCalendarService): AdmissionSchedulingService {
  const notifier = { onBooked: async () => undefined } as unknown as AdmissionNotifier;
  const encryption = { decrypt: async () => 'paciente.e2e@admissionroster.test' } as unknown as KMSEncryptionService;
  return new AdmissionSchedulingService(calendar, notifier, encryption, 'enlite@enlite.health');
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  (DatabaseConnection.getInstance() as unknown as { pool: Pool }).pool = pool;

  process.env.ADMISSION_CALENDAR_ID_AR = CAL_AR;
  process.env.ADMISSION_HOST_ROSTER_ENABLED = 'true';

  const res = await pool.query<{ id: string }>(
    `INSERT INTO patients (first_name, last_name, country) VALUES ('Paciente', 'E2E Roster', 'AR') RETURNING id`,
  );
  patientId = res.rows[0].id;
});

afterAll(async () => {
  await pool.query(`DELETE FROM admission_appointments WHERE patient_id = $1`, [patientId]);
  await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
  await pool.query('DELETE FROM interview_hosts');
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM admission_appointments WHERE patient_id = $1`, [patientId]);
  // Limpa a tabela INTEIRA, não só os e-mails desta suíte. Aprendido do jeito
  // caro: linhas deixadas por outro uso do banco de teste (um script de
  // gestão rodado à mão, por exemplo) viram atendentes extras e fazem
  // "nenhuma cadastrada" ter três — o teste passa sozinho e falha na suíte.
  await pool.query('DELETE FROM interview_hosts');
});

// ── Migration 283: a trava certa está no lugar ────────────────────────────────

describe('trava anti-corrida (migration 283)', () => {
  it('a trava é por ATENDENTE, e a trava por país saiu', async () => {
    const res = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'admission_appointments'
          AND indexname IN ('uq_admission_appointments_host_slot',
                            'uq_admission_appointments_country_slot')`,
    );
    const names = res.rows.map((r) => r.indexname);
    expect(names).toContain('uq_admission_appointments_host_slot');
    expect(names).not.toContain('uq_admission_appointments_country_slot');
  });

  it('duas atendentes PODEM ter o mesmo horário — era isso que a trava antiga proibia', async () => {
    const slot = SLOT_START.toISO();
    const end = SLOT_START.plus({ hours: 1 }).toISO();

    await pool.query(
      `INSERT INTO admission_appointments (patient_id, country, host_email, host_display_name, slot_start, slot_end, status)
       VALUES ($1,'AR',$2,$3,$4,$5,'booked'), ($1,'AR',$6,$3,$4,$5,'booked')`,
      [patientId, ANA, TEAM_AR, slot, end, MARI],
    );

    const count = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM admission_appointments WHERE patient_id = $1`,
      [patientId],
    );
    expect(count.rows[0].n).toBe('2');
  });

  it('a MESMA atendente não pode ter dois no mesmo horário', async () => {
    const slot = SLOT_START.toISO();
    const end = SLOT_START.plus({ hours: 1 }).toISO();

    await pool.query(
      `INSERT INTO admission_appointments (patient_id, country, host_email, host_display_name, slot_start, slot_end, status)
       VALUES ($1,'AR',$2,$3,$4,$5,'booked')`,
      [patientId, ANA, TEAM_AR, slot, end],
    );

    await expect(
      pool.query(
        `INSERT INTO admission_appointments (patient_id, country, host_email, host_display_name, slot_start, slot_end, status)
         VALUES ($1,'AR',$2,$3,$4,$5,'booked')`,
        [patientId, ANA, TEAM_AR, slot, end],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

// ── Corrida real por um horário ───────────────────────────────────────────────

describe('duas reservas simultâneas', () => {
  async function insertHost(email: string, active = true): Promise<void> {
    await pool.query(
      `INSERT INTO interview_hosts (email, display_name, country, active) VALUES ($1,$2,'AR',$3)`,
      [email, `Nome de ${email}`, active],
    );
  }

  it('duas atendentes livres absorvem os dois pedidos, em pessoas diferentes', async () => {
    await insertHost(ANA);
    await insertHost(MARI);
    const createdEvents: string[] = [];
    const service = makeService(stubCalendar({ createdEvents }));
    const params = { patientId, slotStartISO: SLOT_START.toISO() as string, country: 'AR' as const };

    const [a, b] = await Promise.all([service.book(params, NOW), service.book(params, NOW)]);

    const rows = await pool.query<{ host_email: string }>(
      `SELECT host_email FROM admission_appointments WHERE patient_id = $1 ORDER BY host_email`,
      [patientId],
    );
    expect(rows.rows.map((r) => r.host_email)).toEqual([ANA, MARI]);
    // Um evento por reserva, cada um com uma atendente diferente.
    expect(createdEvents.sort()).toEqual([ANA, MARI]);
    // E o paciente recebeu o nome da EQUIPE nas duas.
    expect([a.hostDisplayName, b.hostDisplayName]).toEqual([TEAM_AR, TEAM_AR]);
  });

  it('uma atendente livre absorve só um pedido; o outro é recusado', async () => {
    await insertHost(ANA);
    const createdEvents: string[] = [];
    const service = makeService(stubCalendar({ createdEvents }));
    const params = { patientId, slotStartISO: SLOT_START.toISO() as string, country: 'AR' as const };

    const results = await Promise.allSettled([
      service.book(params, NOW),
      service.book(params, NOW),
    ]);

    const aceitos = results.filter((r) => r.status === 'fulfilled');
    const recusados = results.filter((r) => r.status === 'rejected');
    expect(aceitos).toHaveLength(1);
    expect(recusados).toHaveLength(1);
    expect((recusados[0] as PromiseRejectedResult).reason).toBeInstanceOf(SlotTakenError);

    // O que importa: um evento só no Google, uma linha só no banco.
    expect(createdEvents).toHaveLength(1);
    const rows = await pool.query(
      `SELECT id FROM admission_appointments WHERE patient_id = $1`,
      [patientId],
    );
    expect(rows.rowCount).toBe(1);
  });

  it('atendente inativa não recebe agendamento', async () => {
    await insertHost(ANA, false);
    await insertHost(MARI);
    const service = makeService(stubCalendar());

    await service.book(
      { patientId, slotStartISO: SLOT_START.toISO() as string, country: 'AR' },
      NOW,
    );

    const rows = await pool.query<{ host_email: string }>(
      `SELECT host_email FROM admission_appointments WHERE patient_id = $1`,
      [patientId],
    );
    expect(rows.rows[0].host_email).toBe(MARI);
  });

  it('nenhuma atendente cadastrada → recusa, sem linha e sem evento', async () => {
    const createdEvents: string[] = [];
    const service = makeService(stubCalendar({ createdEvents }));

    await expect(
      service.book({ patientId, slotStartISO: SLOT_START.toISO() as string, country: 'AR' }, NOW),
    ).rejects.toBeInstanceOf(SlotTakenError);

    expect(createdEvents).toHaveLength(0);
    const rows = await pool.query(
      `SELECT id FROM admission_appointments WHERE patient_id = $1`,
      [patientId],
    );
    expect(rows.rowCount).toBe(0);
  });
});

// ── Antecedência mínima na escrita ────────────────────────────────────────────

describe('antecedência mínima de 4h', () => {
  it('pedido dentro da janela é recusado, sem evento e sem linha no banco', async () => {
    await pool.query(
      `INSERT INTO interview_hosts (email, display_name, country, active) VALUES ($1,'Ana','AR',true)`,
      [ANA],
    );
    const createdEvents: string[] = [];
    const service = makeService(stubCalendar({ createdEvents }));
    const emDuasHoras = DateTime.fromJSDate(NOW, { zone: AR_ZONE }).plus({ hours: 2 }).toISO() as string;

    await expect(
      service.book({ patientId, slotStartISO: emDuasHoras, country: 'AR' }, NOW),
    ).rejects.toBeInstanceOf(SlotTakenError);

    expect(createdEvents).toHaveLength(0);
    const rows = await pool.query(
      `SELECT id FROM admission_appointments WHERE patient_id = $1`,
      [patientId],
    );
    expect(rows.rowCount).toBe(0);
  });
});

// ── O endpoint público não conta quem atende (CM6) ───────────────────────────

describe('endpoint público de horários', () => {
  it('país sem atendente ativa responde 200 com lista vazia — não erro', async () => {
    // O stack de teste sobe com o roster LIGADO e `interview_hosts` vazia, que
    // é exatamente o cenário do spec. Antes do roster isto seria 500.
    const res = await axios.get(`${API_URL}/api/public/v1/admission/slots`, {
      params: { country: 'AR' },
      validateStatus: () => true,
    });

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ slots: [] });
  });

  it('agenda inacessível vira 500 genérico — sem vazar e-mail de atendente no erro', async () => {
    // Com atendente cadastrada, o container tenta ler a agenda no Google e não
    // tem credencial. O que importa aqui é o que o paciente recebe quando isso
    // acontece: um erro genérico, sem o e-mail de ninguém dentro.
    await pool.query(
      `INSERT INTO interview_hosts (email, display_name, country, active) VALUES ($1,'Ana Joulie','AR',true)`,
      [ANA],
    );

    const res = await axios.get(`${API_URL}/api/public/v1/admission/slots`, {
      params: { country: 'AR' },
      validateStatus: () => true,
    });

    expect(res.status).toBe(500);
    const corpo = JSON.stringify(res.data);
    expect(corpo).not.toContain('admissionroster.test');
    expect(corpo).not.toContain('Ana Joulie');
  });

  it('país inválido é recusado antes de qualquer leitura de agenda', async () => {
    const res = await axios.get(`${API_URL}/api/public/v1/admission/slots`, {
      params: { country: 'XX' },
      validateStatus: () => true,
    });
    expect(res.status).toBe(400);
  });
});

// ── PEND-09: quem solicitou entra no Meet como convidado ─────────────────────
//
// O buraco que a planning de 26/08 relatou: quando um FAMILIAR preenche o
// formulário, o e-mail vai para `patient_responsibles` e `patients.contact_email`
// fica nulo — o evento saía sem convidado e a pessoa caía na sala de espera.
// Aqui o paciente e o responsável são linhas REAIS no Postgres; só o KMS é
// dublado (modo de teste = base64) e o Google, como sempre neste arquivo.

describe('convidado do Meet = quem solicitou (PEND-09)', () => {
  const RESP_EMAIL = 'responsable.e2e@admissionroster.test';
  let responsiblePatientId: string;

  function makeServiceWithBase64Kms(calendar: AdmissionCalendarService): AdmissionSchedulingService {
    const notifier = { onBooked: async () => undefined } as unknown as AdmissionNotifier;
    // Espelha o KMSEncryptionService em modo de teste (USE_KMS_ENCRYPTION=false): base64.
    const encryption = {
      decrypt: async (c: string) => Buffer.from(c, 'base64').toString('utf8'),
    } as unknown as KMSEncryptionService;
    return new AdmissionSchedulingService(calendar, notifier, encryption, 'enlite@enlite.health');
  }

  beforeAll(async () => {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO patients (first_name, last_name, country, contact_email_encrypted)
       VALUES ('Paciente', 'E2E Responsable', 'AR', NULL) RETURNING id`,
    );
    responsiblePatientId = res.rows[0].id;
    await pool.query(
      `INSERT INTO patient_responsibles (patient_id, first_name, last_name, email_encrypted, is_primary, display_order, source)
       VALUES ($1, 'Familiar', 'E2E', $2, true, 1, 'web_form')`,
      [responsiblePatientId, Buffer.from(RESP_EMAIL, 'utf8').toString('base64')],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM admission_appointments WHERE patient_id = $1`, [responsiblePatientId]);
    await pool.query(`DELETE FROM patient_responsibles WHERE patient_id = $1`, [responsiblePatientId]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [responsiblePatientId]);
  });

  it('paciente sem e-mail + responsável com e-mail no banco → o evento convida o responsável', async () => {
    await pool.query(
      `INSERT INTO interview_hosts (email, display_name, country, active) VALUES ($1, 'Ana', 'AR', true)`,
      [ANA],
    );
    const invitedEmails: (string | undefined)[] = [];
    const service = makeServiceWithBase64Kms(stubCalendar({ invitedEmails }));

    await service.book({ patientId: responsiblePatientId, slotStartISO: SLOT_START.toISO() as string, country: 'AR' }, NOW);

    expect(invitedEmails).toEqual([RESP_EMAIL]);
    // eslint-disable-next-line no-console
    console.log('[PEND-09] convidado no evento:', invitedEmails[0]);
  });

  // Achado do gate `revisao-pr` (BLOCKER): antes da migration 420, um responsável removido virava
  // DELETE — a linha simplesmente não existia mais, e a subquery nunca a via. Depois da 420, ela
  // fica no banco com `active=false`. Sem `AND r.active` em `loadPatientForCountry`, essa linha
  // volta a ser candidata ao convite do Meet — uma pessoa REMOVIDA da ficha entraria na sala da
  // entrevista sem autorização. Prova contra o Postgres REAL (nunca mock de repositório): duas
  // linhas de responsável no MESMO paciente, uma ativa e uma desativada, e `service.book()` real.
  describe('BLOCKER (gate revisao-pr): responsável DESATIVADO não vira convidado', () => {
    const EMAIL_ATIVO = 'ativo.e2e@admissionroster.test';
    const EMAIL_DESATIVADO = 'desativado.e2e@admissionroster.test';
    let patientId: string;

    beforeAll(async () => {
      const res = await pool.query<{ id: string }>(
        `INSERT INTO patients (first_name, last_name, country, contact_email_encrypted)
         VALUES ('Paciente', 'E2E Desativado', 'AR', NULL) RETURNING id`,
      );
      patientId = res.rows[0].id;
      // O responsável REMOVIDO pelo painel — nunca DELETE (spec 018, PR-1, FR-002): a linha
      // continua no banco, só com `active=false`. É TITULAR (`is_primary=true`) e vem PRIMEIRO
      // no `display_order` — de propósito: sem o `AND r.active`, é ELE que a query escolheria
      // (`ORDER BY is_primary DESC, display_order ASC LIMIT 1`), não o ativo abaixo. Se o teste
      // passasse mesmo com os dois em prioridade igual, não provaria nada — o desativado tem de
      // ser quem GANHARIA o desempate para a sabotagem (tirar o `AND r.active`) virar vermelho de
      // verdade.
      await pool.query(
        `INSERT INTO patient_responsibles (patient_id, first_name, last_name, email_encrypted, is_primary, display_order, source, active, deactivated_at, deactivated_by)
         VALUES ($1, 'Familiar', 'Removido', $2, true, 1, 'web_form', false, NOW(), 'e2e-gate')`,
        [patientId, Buffer.from(EMAIL_DESATIVADO, 'utf8').toString('base64')],
      );
      // O titular ATIVO (controle) — não-titular e com display_order pior; só é escolhido porque
      // o de cima está desativado.
      await pool.query(
        `INSERT INTO patient_responsibles (patient_id, first_name, last_name, email_encrypted, is_primary, display_order, source, active)
         VALUES ($1, 'Familiar', 'Ativo', $2, false, 2, 'web_form', true)`,
        [patientId, Buffer.from(EMAIL_ATIVO, 'utf8').toString('base64')],
      );
    });

    afterAll(async () => {
      await pool.query(`DELETE FROM admission_appointments WHERE patient_id = $1`, [patientId]);
      await pool.query(`DELETE FROM patient_responsibles WHERE patient_id = $1`, [patientId]);
      await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    });

    it('paciente sem e-mail próprio, com um responsável ATIVO e um DESATIVADO (ambos com e-mail) → o evento convida SÓ o ativo; o desativado nunca entra na sala', async () => {
      await pool.query(
        `INSERT INTO interview_hosts (email, display_name, country, active) VALUES ($1, 'Ana', 'AR', true)`,
        [ANA],
      );
      const invitedEmails: (string | undefined)[] = [];
      const service = makeServiceWithBase64Kms(stubCalendar({ invitedEmails }));
      // Horário diferente do resto do arquivo — evita SlotTakenError contra um agendamento que
      // outro teste já fez para a mesma atendente no mesmo slot (a trava é por atendente+horário).
      const slotProprio = SLOT_START.plus({ hours: 4 });

      await service.book({ patientId, slotStartISO: slotProprio.toISO() as string, country: 'AR' }, NOW);

      expect(invitedEmails).toEqual([EMAIL_ATIVO]); // só o ativo
      expect(invitedEmails).not.toContain(EMAIL_DESATIVADO); // o removido NUNCA entra na sala
    });
  });
});
