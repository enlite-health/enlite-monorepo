/**
 * Spec 048 — varredura dos lembretes de contato pendente do PT, pelo ENDPOINT interno real
 * (`POST /api/internal/therapeutic-projects/contact-reminders/sweep`, X-Internal-Secret), banco real.
 *
 * SEM relógio real: o teste adianta `due_at` no banco (única coluna mutável do lembrete, de propósito).
 * SEM canal externo: o "aviso" é uma linha em `notifications` (sino in-app) — nenhum Twilio/WhatsApp/e-mail.
 *
 *  1. dia 2 -> UMA notificação ao operador que marcou, listando só os campos pendentes; Master nada; sent_at carimbado
 *  2. 2ª chamada sem nada novo -> 0 (idempotência); 2 chamadas em Promise.all -> exatamente 1 evento
 *  3. preencher 1 campo (versão nova) -> o próximo disparo lista SÓ o que continua pendente
 *  4. tudo preenchido/"No necesita" -> dia 12 cancelado, ciclo RESOLVED, ninguém é avisado
 *  5. dia 12 -> operador + Master (célula incomplete_alert) recebem; ciclo COMPLETED
 *  6. job parado (2 e 5 vencidos) -> UMA notificação pelo maior dia, o menor SUPERSEDED
 *  7. payload só com 4 chaves; sino (GET) mostra o Caso e NUNCA o nome do paciente
 *  8. sem segredo -> 403; alarme de estado conta lembrete vencido há > 1 dia
 */
import axios from 'axios';
import { Pool } from 'pg';
import { grupoComCelulas, limparIamFixtures, tokenMock, TENANT_E2E } from './helpers/permissionFamilyHarness';
import { TherapeuticContactReminderHealthService } from '@shared/events/TherapeuticContactReminderHealthService';

const API_URL = process.env.API_URL || 'http://localhost:8080';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';
const SWEEP = `${API_URL}/api/internal/therapeutic-projects/contact-reminders/sweep`;

const diag = JSON.stringify([{ uri: 'http://id.who.int/icd/entity/1', code: '8B11', title: 'Sintético' }]);
const snap = (l: string) => JSON.stringify([{ id: '11111111-1111-1111-1111-111111111111', label: l }]);

describe('spec 048 — varredura dos lembretes de contato pendente do PT (HTTP real, banco real)', () => {
  let pool: Pool;
  const U = { op: 'pt048s-operador', op2: 'pt048s-operador2', master: 'pt048s-master', inativo: 'pt048s-inativo' };
  const GRUPO = 'PT048S Master';
  const NOME_PACIENTE = 'Zuleica';
  let patient: string;
  let major = 0;
  let cycle: string;

  const sweep = async (headers: Record<string, string> = { 'X-Internal-Secret': SECRET }) =>
    axios.post(SWEEP, null, { headers, validateStatus: () => true });
  const notifsDe = async (uid: string) => (await pool.query<{ payload: any; type_code: string; actor_uid: string; patient_id: string }>(
    `SELECT e.payload, e.type_code, e.actor_uid, e.patient_id FROM notifications n JOIN notification_events e ON e.id = n.event_id
      WHERE n.recipient_uid = $1 AND e.patient_id = $2 ORDER BY n.created_at`, [uid, patient])).rows;
  const eventos = async () => (await pool.query(`SELECT 1 FROM notification_events WHERE patient_id = $1`, [patient])).rowCount;

  /** Versão nova NA MESMA TRANSAÇÃO dos status (como o createVersion faz). `status`: [kind, status, quemMarcou][]. */
  async function versao(status: Array<[string, 'PENDING' | 'NOT_NEEDED', string]>): Promise<string> {
    const cli = await pool.connect();
    try {
      await cli.query('BEGIN');
      const s = await cli.query<{ id: string }>(`INSERT INTO patient_contracted_services (patient_id, service_code, created_by, updated_by) VALUES ($1, 'CAREGIVER', 'e2e', 'e2e') RETURNING id`, [patient]);
      const v = await cli.query<{ id: string }>(
        `INSERT INTO patient_therapeutic_projects (patient_id, major, minor, contracted_service_id, diagnoses, clinical_context, general_objective,
            specific_objectives, activities, pathology_types, start_date, end_date, created_by)
         VALUES ($1, $2, 0, $3, $4, 'ctx', 'obj', $5, $6, $7, '2026-09-01', '2026-12-31', 'e2e') RETURNING id`,
        [patient, ++major, s.rows[0].id, diag, snap('o'), snap('a'), snap('p')]);
      for (const [kind, st, by] of status) {
        await cli.query(
          `INSERT INTO patient_therapeutic_project_contact_status (version_id, patient_id, contact_kind, status, pending_since, marked_by_uid)
           VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'PENDING' THEN now() END, $5)`, [v.rows[0].id, patient, kind, st, by]);
      }
      await cli.query('COMMIT');
      return v.rows[0].id;
    } catch (e) { await cli.query('ROLLBACK').catch(() => undefined); throw e; } finally { cli.release(); }
  }
  /** Ciclo aberto com os 3 lembretes no FUTURO; `vencer(...)` adianta os escolhidos. */
  async function abrirCiclo(versionId: string): Promise<void> {
    cycle = (await pool.query<{ id: string }>(`INSERT INTO patient_tp_contact_reminder_cycles (patient_id, anchor_version_id, opened_by_uid) VALUES ($1, $2, $3) RETURNING id`, [patient, versionId, U.op])).rows[0].id;
    for (const d of [2, 5, 12]) await pool.query(`INSERT INTO patient_tp_contact_reminders (cycle_id, day_offset, due_at) VALUES ($1, $2::int, now() + make_interval(days => $2::int))`, [cycle, d]);
  }
  const vencer = async (...dias: number[]) =>
    pool.query(`UPDATE patient_tp_contact_reminders SET due_at = now() - interval '1 hour' WHERE cycle_id = $1 AND day_offset = ANY($2::int[])`, [cycle, dias]);
  const estado = async () => (await pool.query<{ day_offset: number; sent: boolean; cancel_reason: string | null; skipped_reason: string | null }>(
    `SELECT day_offset, sent_at IS NOT NULL AS sent, cancel_reason, skipped_reason FROM patient_tp_contact_reminders WHERE cycle_id = $1 ORDER BY day_offset`, [cycle])).rows;
  const cicloFechado = async () => (await pool.query(`SELECT close_reason FROM patient_tp_contact_reminder_cycles WHERE id = $1`, [cycle])).rows[0].close_reason as string | null;

  async function novoPaciente(caseNumber: number | null): Promise<void> {
    if (patient) await pool.query(`DELETE FROM patients WHERE id = $1`, [patient]);
    patient = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, is_test, case_number) VALUES ($1, $2, 'Sobrenome', 'AR', true, $3) RETURNING id`,
      [`e2e-048-sweep-${Date.now()}-${Math.random()}`, NOME_PACIENTE, caseNumber])).rows[0].id;
    major = 0;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: [GRUPO] });
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'a@e2e.local', 'Operador A', 'admin', 'ACTIVE', true, $5), ($2, 'b@e2e.local', 'Operador B', 'admin', 'ACTIVE', true, $5),
         ($3, 'm@e2e.local', 'Master', 'admin', 'ACTIVE', true, $5), ($4, 'i@e2e.local', 'Inativo', 'admin', 'DEACTIVATED', false, $5)`,
      [U.op, U.op2, U.master, U.inativo, TENANT_E2E]);
    await grupoComCelulas(pool, { nome: GRUPO, uid: U.master, celulas: [['patient_therapeutic_project', 'incomplete_alert'], ['own_notifications', 'read']] });
  });
  afterAll(async () => {
    if (patient) await pool.query(`DELETE FROM patients WHERE id = $1`, [patient]);
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: [GRUPO] });
    await pool.end();
  });
  beforeEach(async () => {
    await novoPaciente(990048);
  });

  it('1+7. dia 2: UMA notificação ao operador que marcou (só os campos dele, payload de 4 chaves); Master nada; o sino mostra o Caso e NUNCA o nome', async () => {
    const v = await versao([['RESPONSIBLE', 'PENDING', U.op], ['CARE_TEAM', 'PENDING', U.op]]);
    await abrirCiclo(v);
    await vencer(2);

    const r = await sweep();
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ cycles: 1, sent: 1, failed: 0 });

    const n = await notifsDe(U.op);
    expect(n).toHaveLength(1);
    expect(n[0].type_code).toBe('THERAPEUTIC_PROJECT_CONTACTS_PENDING');
    expect(n[0].actor_uid).toBe('system:pt-contact-reminders');
    expect(Object.keys(n[0].payload).sort()).toEqual(['cycleId', 'dayOffset', 'fields', 'versionId']);
    expect(n[0].payload).toMatchObject({ cycleId: cycle, versionId: v, dayOffset: 2, fields: ['RESPONSIBLE', 'CARE_TEAM'] });
    expect(JSON.stringify(n[0].payload)).not.toContain(NOME_PACIENTE);
    expect(await notifsDe(U.master)).toHaveLength(0);
    expect((await estado()).find((x) => x.day_offset === 2)?.sent).toBe(true);

    // GET do sino (API real, mock auth): Caso presente, nome do paciente ausente
    const sino = await axios.get(`${API_URL}/api/admin/notifications`, { headers: { Authorization: tokenMock(U.op, 'admin', 'AR') }, validateStatus: () => true });
    expect(sino.status).toBe(200);
    const item = (sino.data.data?.notifications ?? sino.data.data ?? sino.data.notifications)[0];
    expect(item.typeCode).toBe('THERAPEUTIC_PROJECT_CONTACTS_PENDING');
    expect(item.patientCaseNumber).toBe(990048);
    expect(item.patientDisplayName).toBeNull();
    expect(JSON.stringify(sino.data)).not.toContain(NOME_PACIENTE);
  });

  it('2. idempotência: 2ª chamada sem nada novo não cria nada; 2 chamadas em paralelo criam exatamente 1 evento', async () => {
    const v = await versao([['COVERAGE', 'PENDING', U.op]]);
    await abrirCiclo(v);
    await vencer(2);
    const [a, b] = await Promise.all([sweep(), sweep()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await eventos()).toBe(1);
    expect((await notifsDe(U.op))).toHaveLength(1);

    const depois = await sweep();
    expect(depois.data).toMatchObject({ cycles: 0, sent: 0 });
    expect(await eventos()).toBe(1);
  });

  it('3. preencher 1 campo (versão nova): o próximo disparo lista SÓ o que continua pendente', async () => {
    const v1 = await versao([['RESPONSIBLE', 'PENDING', U.op], ['CARE_TEAM', 'PENDING', U.op]]);
    await abrirCiclo(v1);
    await vencer(2);
    await sweep();
    await versao([['CARE_TEAM', 'PENDING', U.op]]); // RESPONSIBLE foi preenchido (sem status na versão nova)
    await vencer(5);
    const r = await sweep();
    expect(r.data).toMatchObject({ sent: 1 });
    const n = await notifsDe(U.op);
    expect(n).toHaveLength(2);
    expect(n[1].payload.fields).toEqual(['CARE_TEAM']);
    expect(n[1].payload.dayOffset).toBe(5);
  });

  it('4. tudo preenchido (ou "No necesita"): dia 12 cancelado, ciclo RESOLVED, NINGUÉM é avisado', async () => {
    const v1 = await versao([['RESPONSIBLE', 'PENDING', U.op]]);
    await abrirCiclo(v1);
    await versao([['RESPONSIBLE', 'NOT_NEEDED', U.master]]);
    await vencer(2, 5, 12);
    const r = await sweep();
    expect(r.data).toMatchObject({ cycles: 1, sent: 0, cancelled: 3 });
    expect(await eventos()).toBe(0);
    expect(await cicloFechado()).toBe('RESOLVED');
    expect((await estado()).every((x) => !x.sent && x.cancel_reason === 'RESOLVED')).toBe(true);
  });

  it('5. dia 12: o operador (pelos campos dele) e o Master com `incomplete_alert` (todos os pendentes) recebem; ciclo COMPLETED; staff inativo e quem não tem a célula, nada', async () => {
    const v = await versao([['RESPONSIBLE', 'PENDING', U.op], ['EXTERNAL', 'PENDING', U.op2], ['CARE_TEAM', 'PENDING', U.inativo]]);
    await abrirCiclo(v);
    await vencer(2, 5, 12);
    const r = await sweep();
    expect(r.data).toMatchObject({ cycles: 1, sent: 1, superseded: 2 });
    expect((await notifsDe(U.op))[0].payload.fields).toEqual(['RESPONSIBLE']);
    expect((await notifsDe(U.op2))[0].payload.fields).toEqual(['EXTERNAL']);
    expect((await notifsDe(U.master))[0].payload.fields).toEqual(['RESPONSIBLE', 'EXTERNAL', 'CARE_TEAM']);
    expect(await notifsDe(U.inativo)).toHaveLength(0);
    expect((await notifsDe(U.master))[0].payload.dayOffset).toBe(12);
    expect(await cicloFechado()).toBe('COMPLETED');
  });

  it('6. job parado (dias 2 e 5 vencidos juntos): UMA notificação pelo maior dia; o menor vira SUPERSEDED', async () => {
    const v = await versao([['COVERAGE', 'PENDING', U.op]]);
    await abrirCiclo(v);
    await vencer(2, 5);
    const r = await sweep();
    expect(r.data).toMatchObject({ sent: 1, superseded: 1 });
    expect(await notifsDe(U.op)).toHaveLength(1);
    const e = await estado();
    expect(e.find((x) => x.day_offset === 2)?.cancel_reason).toBe('SUPERSEDED');
    expect(e.find((x) => x.day_offset === 5)?.sent).toBe(true);
    expect(await cicloFechado()).toBeNull();
  });

  it('operador desativado e ninguém com a célula (dia 2): carimba como NO_ACTIVE_RECIPIENT, sem evento vazio', async () => {
    const v = await versao([['COVERAGE', 'PENDING', U.inativo]]);
    await abrirCiclo(v);
    await vencer(2);
    const r = await sweep();
    expect(r.data).toMatchObject({ sent: 0, skippedNoRecipient: 1 });
    expect(await eventos()).toBe(0);
    expect((await estado()).find((x) => x.day_offset === 2)?.skipped_reason).toBe('NO_ACTIVE_RECIPIENT');
  });

  it('paciente sem número de caso: o sino devolve patientCaseNumber null (o front mostra "Caso sin número")', async () => {
    await novoPaciente(null);
    const v = await versao([['COVERAGE', 'PENDING', U.op]]);
    await abrirCiclo(v);
    await vencer(2);
    await sweep();
    const sino = await axios.get(`${API_URL}/api/admin/notifications`, { headers: { Authorization: tokenMock(U.op, 'admin', 'AR') }, validateStatus: () => true });
    const lista = (sino.data.data?.notifications ?? sino.data.data ?? sino.data.notifications) as Array<{ patientCaseNumber: number | null }>;
    expect(lista[0].patientCaseNumber).toBeNull();
  });

  it('8. sem segredo → 403 e nada processado; o alarme de estado conta lembrete vencido há > 1 dia', async () => {
    const v = await versao([['COVERAGE', 'PENDING', U.op]]);
    await abrirCiclo(v);
    await vencer(2);
    const negado = await sweep({});
    expect(negado.status).toBe(403);
    expect((await estado()).some((x) => x.sent)).toBe(false);

    await pool.query(`UPDATE patient_tp_contact_reminders SET due_at = now() - interval '3 days' WHERE cycle_id = $1 AND day_offset = 2`, [cycle]);
    const health = await new TherapeuticContactReminderHealthService(pool).getHealth(24);
    expect(health.overdue).toBeGreaterThanOrEqual(1);
    expect(health.oldestOverdueHours).toBeGreaterThanOrEqual(72);
    await sweep(); // drena o que o teste deixou
    expect((await new TherapeuticContactReminderHealthService(pool).getHealth(24)).overdue).toBe(0);
  });
});
