/**
 * c1b-on-hold-note-preservation.e2e.test.ts @integration — C1 do relatório F5 (BLOCKER B7).
 *
 * O defeito, medido ponta a ponta: a operadora SEM `patient_clinical:read` recebe
 * `onHoldNote: null` + `onHoldNoteRedacted: true` na ficha, o textarea nasce vazio e desabilitado,
 * e o `PUT /:id/status` mandava `onHoldNote: null` mesmo assim. A guarda do controller só barrava
 * valor NÃO-NULO — logo barrava quem ESCREVE e liberava quem APAGA. `moveStatus` gravava
 * `SET on_hold_note = $4` sem condição, e `patient_status_history` nunca carrega a nota:
 * a perda é IRRECUPERÁVEL.
 *
 * Postgres REAL (nada de mock de banco): o caminho de produção
 * `AdminPatientsController.updatePatientStatus` → `PatientService.moveStatus` → `UPDATE patients`
 * roda inteiro; a asserção lê a coluna de volta do banco.
 *
 * Por que o controller é chamado direto e não por HTTP: NENHUM middleware monta
 * `req.permissionCells` hoje (fail-open D113, `patientClinicalAccess.ts:14-19`) — pela rota o ator
 * redigido não existe ainda. A request é montada aqui com `permissionCells: []`, que é exatamente
 * o que o engine do ABAC vai pendurar ("ator conhecido e sem célula").
 */
import { Pool } from 'pg';
import { AdminPatientsController } from '@modules/case/interfaces/controllers/AdminPatientsController';
import type { Request, Response } from 'express';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const NOTE = 'C1B-nota-clinica-irrecuperavel-4f7a: la obra social pidió resumen de historia clínica';
const TAG = 'C1B-on-hold-note-%';

type Captured = { status: number; body: unknown };

/** Request/Response de verdade o bastante para o controller — `permissionCells` é o ponto do teste. */
function reqRes(
  id: string,
  body: Record<string, unknown>,
  permissionCells: readonly string[] | undefined,
): [Request, Response, Captured] {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    status(code: number) { captured.status = code; return this; },
    json(payload: unknown) { captured.body = payload; return this; },
  } as unknown as Response;
  const req = { params: { id }, body, query: {}, ...(permissionCells === undefined ? {} : { permissionCells }) } as unknown as Request;
  return [req, res, captured];
}

describe('C1 — a nota clínica de ON_HOLD sobrevive a quem não pode lê-la (Postgres real) @integration', () => {
  let pool: Pool;
  const controller = new AdminPatientsController();
  let patientId = '';

  const noteInDb = async (): Promise<string | null> =>
    (await pool.query<{ on_hold_note: string | null }>('SELECT on_hold_note FROM patients WHERE id = $1', [patientId])).rows[0].on_hold_note;
  const reasonInDb = async (): Promise<string | null> =>
    (await pool.query<{ on_hold_reason: string | null }>('SELECT on_hold_reason FROM patients WHERE id = $1', [patientId])).rows[0].on_hold_reason;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('DELETE FROM patients WHERE clickup_task_id LIKE $1', [TAG]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM patients WHERE clickup_task_id LIKE $1', [TAG]);
    patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, on_hold_reason, on_hold_note)
       VALUES ('C1B-on-hold-note-1', 'C1B', 'Paciente QA', 'AR', 'ON_HOLD', 'INSURER', $1) RETURNING id`,
      [NOTE],
    )).rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM patients WHERE clickup_task_id LIKE $1', [TAG]);
    await pool.end();
  });

  it('a. operadora REDIGIDA muda só o motivo mandando `onHoldNote: null` → 403 e a nota SOBREVIVE no banco', async () => {
    expect(await noteInDb()).toBe(NOTE); // controle positivo: a nota estava lá

    const [req, res, out] = reqRes(patientId, { status: 'ON_HOLD', onHoldReason: 'OTHER', onHoldNote: null }, []);
    await controller.updatePatientStatus(req, res);

    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ success: false, details: { field: 'onHoldNote', cell: 'patient_clinical:read' } });
    expect(await noteInDb()).toBe(NOTE);
    expect(await reasonInDb()).toBe('INSURER'); // 403 = nada mudou
  });

  it('b. operadora REDIGIDA OMITE a chave (o que a tela corrigida manda) → 200, motivo muda, nota SOBREVIVE', async () => {
    const [req, res, out] = reqRes(patientId, { status: 'ON_HOLD', onHoldReason: 'OTHER' }, []);
    await controller.updatePatientStatus(req, res);

    expect(out.status).toBe(200);
    expect(await reasonInDb()).toBe('OTHER');
    expect(await noteInDb()).toBe(NOTE);
  });

  it('c. ator que PODE ler muda só o motivo sem mandar a chave → 200 e a nota SOBREVIVE (ON_HOLD → ON_HOLD)', async () => {
    const [req, res, out] = reqRes(patientId, { status: 'ON_HOLD', onHoldReason: 'SCHOOL' }, ['patient_clinical:read']);
    await controller.updatePatientStatus(req, res);

    expect(out.status).toBe(200);
    expect(await reasonInDb()).toBe('SCHOOL');
    expect(await noteInDb()).toBe(NOTE);
  });

  it('d. quem PODE ler continua podendo APAGAR de propósito (`onHoldNote: null` explícito) → 200 e a nota vai a NULL', async () => {
    const [req, res, out] = reqRes(patientId, { status: 'ON_HOLD', onHoldReason: 'OTHER', onHoldNote: null }, ['patient_clinical:read']);
    await controller.updatePatientStatus(req, res);

    expect(out.status).toBe(200);
    expect(await noteInDb()).toBeNull();
  });

  it('C5. DEMOÇÃO de estado clínico para a coluna de admissão → 422, e motivo e nota SOBREVIVEM', async () => {
    // A checagem de transição só rodava quando o ALVO era clínico. Arrastar o card de ACTIVE/
    // ON_HOLD para a coluna de admissão passava sem 422 e o mesmo UPDATE limpava motivo e nota.
    // O seed da migration 315 não tem NENHUMA transição de estado clínico para o funil.
    const { rows } = await pool.query(
      `SELECT 1 FROM patient_status_transitions WHERE from_status = 'ON_HOLD' AND to_status = 'ADMISSION'`,
    );
    expect(rows).toHaveLength(0); // controle positivo: a tabela realmente não permite

    const [req, res, out] = reqRes(patientId, { status: 'ADMISSION', changeSource: 'kanban' }, ['patient_clinical:read']);
    await controller.updatePatientStatus(req, res);

    expect(out.status).toBe(422);
    expect(out.body).toMatchObject({ code: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED', details: { from: 'ON_HOLD', to: 'ADMISSION' } });
    const { rows: [p] } = await pool.query<{ status: string; on_hold_reason: string | null; on_hold_note: string | null }>(
      'SELECT status, on_hold_reason, on_hold_note FROM patients WHERE id = $1', [patientId]);
    expect(p).toEqual({ status: 'ON_HOLD', on_hold_reason: 'INSURER', on_hold_note: NOTE });
  });

  it('C5-b. movimento DENTRO do funil segue livre (controle positivo: a trava é de SAÍDA do clínico)', async () => {
    const lead = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ('C1B-on-hold-note-2', 'C1B', 'Lead QA', 'AR', 'SOLICITANTE') RETURNING id`,
    )).rows[0].id;
    const [req, res, out] = reqRes(lead, { status: 'ADMISSION', changeSource: 'kanban' }, ['patient_clinical:read']);
    await controller.updatePatientStatus(req, res);
    expect(out.status).toBe(200);
    expect((await pool.query('SELECT status FROM patients WHERE id = $1', [lead])).rows[0].status).toBe('ADMISSION');
  });

  it('e. sair de ON_HOLD continua limpando motivo e nota (lex C7.1-e: nenhuma segunda cópia)', async () => {
    const [req, res, out] = reqRes(patientId, { status: 'ACTIVE' }, ['patient_clinical:read']);
    await controller.updatePatientStatus(req, res);

    expect(out.status).toBe(200);
    expect(await noteInDb()).toBeNull();
    expect(await reasonInDb()).toBeNull();
  });
});
