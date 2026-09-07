/**
 * c1b-contracted-service-write-guards.e2e.test.ts @integration — C4 e C7 do relatório F5.
 *
 * C4 — `hourlyValue` era restrito na LEITURA (`projectContractedServiceForActor` devolve
 *      `null` + `hourlyValueRedacted: true` para quem não é admin) e livre na ESCRITA: a rota é
 *      `staffOnly` e o schema aceitava o campo de qualquer um. Um `recruiter` gravava 0 por cima
 *      do preço do contrato que ele não pode ver.
 * C7 — `country` vinha do corpo e chegava ao repositório. O trigger da 319 só preenche quando a
 *      coluna vem NULL, então o valor explícito VENCIA: `POST {country:'BR'}` num paciente AR
 *      carimbava BR — na coluna que existe exatamente para ser a fronteira de país.
 *
 * Postgres real: a asserção lê `hourly_value` e `country` de volta do banco.
 */
import { Pool } from 'pg';
import type { Request, Response } from 'express';
import { AdminPatientContractedServicesController } from '@modules/case/interfaces/controllers/AdminPatientContractedServicesController';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TAG = 'C1B-cs-guards-%';
const PRECO = 4321;

type Captured = { status: number; body: unknown };
// `cells` ausente = o engine não decidiu (família fora do enforcement) → papel decide (D113).
// `cells` presente = o engine decidiu → só a célula `patient_contract_value:read` decide.
function reqRes(params: Record<string, string>, body: Record<string, unknown>, roles: string[], cells?: string[]): [Request, Response, Captured] {
  const captured: Captured = { status: 0, body: undefined };
  const res = {
    status(code: number) { captured.status = code; return this; },
    json(payload: unknown) { captured.body = payload; return this; },
  } as unknown as Response;
  return [{ params, body, query: {}, user: { roles }, ...(cells ? { permissionCells: cells } : {}) } as unknown as Request, res, captured];
}

describe('C4/C7 — escrita do serviço contratado: valor restrito e país da fronteira (Postgres real) @integration', () => {
  let pool: Pool;
  const controller = new AdminPatientContractedServicesController();
  let patientId = '';
  let serviceId = '';

  const limpar = async (): Promise<void> => {
    await pool.query(`DELETE FROM patient_contracted_services WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`, [TAG]);
    await pool.query('DELETE FROM patients WHERE clickup_task_id LIKE $1', [TAG]);
  };
  const svc = async () => (await pool.query<{ hourly_value: string | null; country: string }>(
    'SELECT hourly_value, country FROM patient_contracted_services WHERE id = $1', [serviceId])).rows[0];

  beforeAll(async () => { pool = new Pool({ connectionString: DATABASE_URL }); await limpar(); });

  beforeEach(async () => {
    await limpar();
    patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ('C1B-cs-guards-1', 'C1B', 'Servicio QA', 'AR', 'ACTIVE') RETURNING id`,
    )).rows[0].id;
    serviceId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, active, hourly_value, created_by, updated_by)
       VALUES ($1, 'CAREGIVER', true, $2, 'c1b', 'c1b') RETURNING id`, [patientId, PRECO],
    )).rows[0].id;
  });

  afterAll(async () => { await limpar(); await pool.end(); });

  it('C4-a. `recruiter` mandando `hourlyValue: 0` → 403 e o preço no banco NÃO muda', async () => {
    const [req, res, out] = reqRes({ id: patientId, sid: serviceId }, { hourlyValue: 0 }, ['recruiter']);
    await controller.update(req, res);
    expect(out.status).toBe(403);
    expect(out.body).toMatchObject({ success: false, details: { field: 'hourlyValue' } });
    expect(Number((await svc()).hourly_value)).toBe(PRECO);
  });

  it('C4-b. `admin` mandando `hourlyValue` grava (controle positivo: sem decisão do engine, a trava é de PAPEL)', async () => {
    const [req, res, out] = reqRes({ id: patientId, sid: serviceId }, { hourlyValue: 5000 }, ['admin']);
    await controller.update(req, res);
    expect(out.status).toBe(200);
    expect(Number((await svc()).hourly_value)).toBe(5000);
  });

  it('C4-c. `recruiter` editando OUTRO campo passa, e o preço que ele não vê continua intacto', async () => {
    const [req, res, out] = reqRes({ id: patientId, sid: serviceId }, { weeklyHours: 20 }, ['recruiter']);
    await controller.update(req, res);
    expect(out.status).toBe(200);
    expect((out.body as { data: { hourlyValue: number | null; hourlyValueRedacted: boolean } }).data).toMatchObject({ hourlyValue: null, hourlyValueRedacted: true });
    expect(Number((await svc()).hourly_value)).toBe(PRECO);
  });

  // 07/09 — o papel deixou de ser nível: com o engine decidindo, só a célula conta.
  it('C4-d. engine decidiu: `recruiter` COM `patient_contract_value:read` grava e lê o preço', async () => {
    const [req, res, out] = reqRes({ id: patientId, sid: serviceId }, { hourlyValue: 6000 }, ['recruiter'], ['patient_services:write', 'patient_contract_value:read']);
    await controller.update(req, res);
    expect(out.status).toBe(200);
    expect((out.body as { data: { hourlyValue: number | null; hourlyValueRedacted: boolean } }).data).toMatchObject({ hourlyValue: 6000, hourlyValueRedacted: false });
    expect(Number((await svc()).hourly_value)).toBe(6000);
  });

  it('C4-e. engine decidiu: `admin` SEM a célula → 403 na escrita e redigido na leitura — o papel não abre mais nada', async () => {
    const [req, res, out] = reqRes({ id: patientId, sid: serviceId }, { hourlyValue: 0 }, ['admin'], ['patient_services:write']);
    await controller.update(req, res);
    expect(out.status).toBe(403);
    expect(Number((await svc()).hourly_value)).toBe(PRECO);

    const [req2, res2, out2] = reqRes({ id: patientId, sid: serviceId }, { weeklyHours: 10 }, ['admin'], ['patient_services:write']);
    await controller.update(req2, res2);
    expect(out2.status).toBe(200);
    expect((out2.body as { data: { hourlyValue: number | null; hourlyValueRedacted: boolean } }).data).toMatchObject({ hourlyValue: null, hourlyValueRedacted: true });
  });

  it('C7. `POST {country:"BR"}` num paciente AR é RECUSADO (400) — e nada é criado', async () => {
    const antes = Number((await pool.query('SELECT COUNT(*)::int AS n FROM patient_contracted_services WHERE patient_id = $1', [patientId])).rows[0].n);
    const [req, res, out] = reqRes({ id: patientId }, { serviceCode: 'NURSE', country: 'BR' }, ['admin']);
    await controller.create(req, res);
    expect(out.status).toBe(400);
    const depois = Number((await pool.query('SELECT COUNT(*)::int AS n FROM patient_contracted_services WHERE patient_id = $1', [patientId])).rows[0].n);
    expect(depois).toBe(antes);
  });

  it('C7-b. criado SEM `country`, o serviço herda a jurisdição do PACIENTE (trigger da 319)', async () => {
    const [req, res, out] = reqRes({ id: patientId }, { serviceCode: 'NURSE' }, ['admin']);
    await controller.create(req, res);
    expect(out.status).toBe(201);
    const criado = (out.body as { data: { id: string; country: string } }).data;
    expect(criado.country).toBe('AR');
    const { rows } = await pool.query<{ country: string }>('SELECT country FROM patient_contracted_services WHERE id = $1', [criado.id]);
    expect(rows[0].country).toBe('AR');
  });
});
